"""Shared helpers: env, LLM (FreeLLMAPI via bridge /v1), Langfuse, Dify, Daytona. Secrets read from app-stack/.env only."""
import os, json, re, pathlib, httpx
from dotenv import load_dotenv
ROOT = pathlib.Path(__file__).resolve().parents[3]           # C:\Users\henry\app-stack
load_dotenv(ROOT / ".env", override=True)
E = lambda k, d="": os.getenv(k) or d
DATA = pathlib.Path(__file__).resolve().parents[1] / "packages" / "domain-uk-tax"
CATS = json.loads((DATA / "categories.json").read_text())["accounts"]

def langfuse():
    try:
        from langfuse import Langfuse
        return Langfuse(public_key=E("LANGFUSE_PUBLIC_KEY"), secret_key=E("LANGFUSE_SECRET_KEY"), host=E("LANGFUSE_HOST", "http://localhost:3000"))
    except Exception as e:
        print("langfuse unavailable:", e); return None

def llm(messages, temperature=0):
    base = E("FREELLMAPI_BASE_URL", "http://127.0.0.1:31415/v1").rstrip("/")
    r = httpx.post(base + "/chat/completions", timeout=120, headers={"Authorization": "Bearer " + E("FREELLMAPI_KEY")},
                   json={"model": E("FREELLMAPI_MODEL", "llama-3.3-70b-fp8-fast"), "messages": messages, "temperature": temperature})
    r.raise_for_status(); return r.json()["choices"][0]["message"]["content"]

def json_from(text):
    m = re.search(r"\{.*\}|\[.*\]", text, re.S); return json.loads(m.group(0)) if m else None

def rule_category(desc):
    d = desc.lower()
    for a in CATS:
        if any(k in d for k in a["kw"]): return a["code"], a["name"], 0.9
    return None

def dify_categorise(lines):
    """Optional: route categorise through a Dify app if DIFY_API_KEY is set. Returns None on any failure."""
    key, base = E("DIFY_API_KEY"), E("DIFY_API_URL", "http://localhost:8080/v1").rstrip("/")
    if not key: return None
    try:
        q = "Categorise into account codes " + json.dumps([{"c": a["code"], "n": a["name"]} for a in CATS]) + \
            ". Reply ONLY JSON list of {i, code, confidence}. Lines: " + json.dumps(lines)
        r = httpx.post(base + "/chat-messages", timeout=120, headers={"Authorization": "Bearer " + key},
                       json={"inputs": {}, "query": q, "response_mode": "streaming", "user": "autopilot-demo"})
        r.raise_for_status(); ans = ""
        for line in r.text.splitlines():  # agent apps only support streaming; assemble SSE chunks
            if line.startswith("data:"):
                try: ev = json.loads(line[5:])
                except Exception: continue
                if ev.get("event") in ("message", "agent_message"): ans += ev.get("answer", "")
        return json_from(ans)
    except Exception as e:
        print("dify categorise skipped:", type(e).__name__, str(e)[:120]); return None

def daytona_parse(csv_text):
    """Optional: parse untrusted CSV in a Daytona sandbox. Falls back to local parse (synthetic data only)."""
    if not E("DAYTONA_API_KEY"): return None, "no DAYTONA_API_KEY"
    try:
        from daytona import Daytona  # pip install daytona
        d = Daytona(); sb = d.create()
        try:
            code = "import csv,io,json;print(json.dumps(list(csv.DictReader(io.StringIO(%r)))))" % csv_text
            res = sb.process.code_run(code); return json.loads(res.result), "daytona"
        finally: d.delete(sb)
    except Exception as e:
        return None, f"daytona fallback: {type(e).__name__}: {str(e)[:120]}"
