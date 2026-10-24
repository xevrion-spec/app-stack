"""Local bridge exposing CrewAI, Crawl4AI and Temporal to Dify. Auth: Bearer BRIDGE_TOKEN."""
import os, json, subprocess, sys, uuid, pathlib
from dotenv import load_dotenv
ROOT = pathlib.Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

TOKEN = os.getenv("BRIDGE_TOKEN", "")
LLM_BASE = os.getenv("FREELLMAPI_BASE_URL", "http://127.0.0.1:31415/v1")
LLM_KEY = os.getenv("FREELLMAPI_KEY", "")
LLM_MODEL = os.getenv("FREELLMAPI_MODEL", "auto")
CRAWL_PY = os.getenv("CRAWL4AI_PYTHON", r"C:\Users\henry\crawl_env\Scripts\python.exe")
CREW_PY = os.getenv("CREWAI_PYTHON", CRAWL_PY)
app = FastAPI(title="app-stack bridge")
from admin import r as admin_router
app.include_router(admin_router)
from dashboard import r as dashboard_router
app.include_router(dashboard_router)

try:
    from langfuse import Langfuse
    lf = Langfuse(public_key=os.getenv("LANGFUSE_PUBLIC_KEY"), secret_key=os.getenv("LANGFUSE_SECRET_KEY"), host=os.getenv("LANGFUSE_HOST"))
except Exception:
    lf = None

def auth(a):
    if TOKEN and a != f"Bearer {TOKEN}":
        raise HTTPException(401, "bad token")

def trace(name, inp, out):
    if not lf: return None
    try:
        with lf.start_as_current_observation(name=name, as_type="span", input=inp) as s:
            s.update(output=out)
            tid = s.trace_id
        lf.flush(); return tid
    except Exception as e:
        return f"trace-error: {e}"

def run_py(py, code, payload, timeout=900):
    env = dict(os.environ, OPENAI_API_BASE=LLM_BASE, OPENAI_BASE_URL=LLM_BASE, OPENAI_API_KEY=LLM_KEY, PAYLOAD=json.dumps(payload))
    r = subprocess.run([py, "-c", code], capture_output=True, text=True, timeout=timeout, env=env)
    if r.returncode: raise HTTPException(500, r.stderr[-2000:])
    return r.stdout.strip().splitlines()[-1] if r.stdout.strip() else ""

@app.get("/health")
def health(): return {"ok": True, "llm_base": LLM_BASE, "langfuse": bool(lf)}

class Chat(BaseModel): prompt: str; model: str | None = None
@app.post("/llm")
def llm(b: Chat, authorization: str = Header(None)):
    auth(authorization)
    from openai import OpenAI
    c = OpenAI(base_url=LLM_BASE, api_key=LLM_KEY)
    r = c.chat.completions.create(model=b.model or LLM_MODEL, messages=[{"role": "user", "content": b.prompt}])
    out = r.choices[0].message.content
    return {"output": out, "model": r.model, "trace_id": trace("bridge.llm", b.prompt, out)}

class Crawl(BaseModel): url: str
CRAWL_CODE = r'''
import os,json,asyncio
from crawl4ai import AsyncWebCrawler
async def m():
    async with AsyncWebCrawler() as c:
        r=await c.arun(url=json.loads(os.environ["PAYLOAD"])["url"])
        print(json.dumps({"markdown":str(r.markdown)[:50000]}))
asyncio.run(m())
'''
@app.post("/crawl")
def crawl(b: Crawl, authorization: str = Header(None)):
    auth(authorization)
    out = json.loads(run_py(CRAWL_PY, CRAWL_CODE, b.model_dump(), 300))
    out["trace_id"] = trace("bridge.crawl", b.url, out["markdown"][:2000]); return out

class Crew(BaseModel): topic: str; goal: str = "Research the topic and write a concise brief"
CREW_CODE = r'''
import os,json
from crewai import Agent,Task,Crew,LLM
p=json.loads(os.environ["PAYLOAD"])
llm=LLM(model="openai/"+os.environ.get("FREELLMAPI_MODEL","auto"),base_url=os.environ["OPENAI_BASE_URL"],api_key=os.environ["OPENAI_API_KEY"])
a=Agent(role="Researcher",goal=p["goal"],backstory="Analyst at Xevrion",llm=llm)
t=Task(description=f"{p['goal']}: {p['topic']}",expected_output="A short brief",agent=a)
print(json.dumps({"output":str(Crew(agents=[a],tasks=[t]).kickoff())}))
'''
@app.post("/crew/run")
def crew(b: Crew, authorization: str = Header(None)):
    auth(authorization)
    out = json.loads(run_py(CREW_PY, CREW_CODE, b.model_dump()))
    out["trace_id"] = trace("bridge.crew", b.model_dump(), out["output"]); return out

class WF(BaseModel): workflow: str; task_queue: str = "default"; args: list = []; workflow_id: str | None = None
async def tclient():
    from temporalio.client import Client
    return await Client.connect(os.getenv("TEMPORAL_ADDRESS", "localhost:7233"), namespace=os.getenv("TEMPORAL_NAMESPACE", "default"))
@app.post("/temporal/start")
async def tstart(b: WF, authorization: str = Header(None)):
    auth(authorization)
    c = await tclient(); wid = b.workflow_id or f"{b.workflow}-{uuid.uuid4().hex[:8]}"
    h = await c.start_workflow(b.workflow, args=b.args, id=wid, task_queue=b.task_queue)
    trace("bridge.temporal.start", b.model_dump(), {"workflow_id": wid})
    return {"workflow_id": wid, "run_id": h.result_run_id}
@app.get("/temporal/describe/{wid}")
async def tdesc(wid: str, authorization: str = Header(None)):
    auth(authorization)
    d = await (await tclient()).get_workflow_handle(wid).describe()
    return {"workflow_id": wid, "status": str(d.status), "type": d.workflow_type}
