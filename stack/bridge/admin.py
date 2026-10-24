"""Config/admin endpoints: proxies to each service's documented API using keys from .env.
Destructive / public / email-sending actions require confirm=true."""
import os, subprocess, pathlib, httpx, base64
from fastapi import APIRouter, Header, HTTPException, Body
from typing import Any

ROOT = pathlib.Path(__file__).resolve().parent.parent
r = APIRouter()
E = os.getenv

def _auth(a):
    t = E("BRIDGE_TOKEN", "")
    if t and a != f"Bearer {t}": raise HTTPException(401, "bad token")

def _need(confirm):
    if not confirm: raise HTTPException(400, "This action is destructive, public or sends email: re-call with confirm=true after the user explicitly approves.")

SERVICES = {
 "github":    lambda: ("https://api.github.com", {"Authorization": f"Bearer {E('GITHUB_TOKEN')}", "Accept": "application/vnd.github+json"}),
 "cloudflare":lambda: ("https://api.cloudflare.com/client/v4", {"Authorization": f"Bearer {E('CLOUDFLARE_API_TOKEN')}"}),
 "coolify":   lambda: ("https://app.coolify.io/api/v1", {"Authorization": f"Bearer {E('COOLIFY_API_TOKEN')}"}),
 "daytona":   lambda: ((E("DAYTONA_API_URL") or "https://app.daytona.io/api").rstrip("/"), {"Authorization": f"Bearer {E('DAYTONA_API_KEY')}"}),
 "steel":     lambda: ((E("STEEL_API_URL") or "http://localhost:3001").rstrip("/"), {}),
 "postiz":    lambda: ("https://api.postiz.com/public/v1", {"Authorization": E("POSTIZ_API_KEY") or ""}),
 "loops":     lambda: ("https://app.loops.so/api/v1", {"Authorization": f"Bearer {E('LOOPS_API_KEY')}"}),
 "kapa":      lambda: ("https://api.kapa.ai", {"X-API-KEY": E("KAPA_API_KEY") or ""}),
 "langfuse":  lambda: ((E("LANGFUSE_HOST") or "http://localhost:3000").rstrip("/"),
                       {"Authorization": "Basic " + base64.b64encode(f"{E('LANGFUSE_PUBLIC_KEY')}:{E('LANGFUSE_SECRET_KEY')}".encode()).decode()}),
}
# (service, method, path-prefix) combos that need confirm=true
GUARDED = [
 ("*", "DELETE", ""),
 ("loops", "POST", "/transactional"), ("loops", "POST", "/events/send"),
 ("postiz", "POST", "/posts"),
 ("github", "POST", "/repos"), ("github", "PUT", "/repos"), ("github", "PATCH", "/repos"),
 ("coolify", "GET", "/deploy"), ("coolify", "POST", "/applications"), ("coolify", "PATCH", "/applications"),
 ("cloudflare", "PUT", "/accounts"), ("cloudflare", "POST", "/zones"), ("cloudflare", "PATCH", "/zones"),
]
def _guarded(svc, m, path):
    return any((s in ("*", svc)) and m == gm and path.startswith(p) for s, gm, p in GUARDED)

@r.post("/api/{service}")
def call(service: str, body: dict = Body(...), authorization: str = Header(None)):
    """body: {method, path, query?, json?, confirm?} -> proxied to the service's documented REST API."""
    _auth(authorization)
    if service not in SERVICES: raise HTTPException(404, f"unknown service; one of {list(SERVICES)}")
    m = str(body.get("method", "GET")).upper(); path = "/" + str(body.get("path", "")).lstrip("/")
    if service == "postiz" and m == "POST" and path.startswith("/posts") and (body.get("json") or {}).get("type") == "draft":
        pass
    elif _guarded(service, m, path): _need(body.get("confirm"))
    base, hdr = SERVICES[service]()
    res = httpx.request(m, base + path, params=body.get("query"), json=body.get("json"), headers=hdr, timeout=120)
    try: data: Any = res.json()
    except Exception: data = res.text[:20000]
    return {"status": res.status_code, "data": data}

APPS = ["dify", "langfuse", "postiz", "temporal", "steel", "daytona", "freellmapi"]
@r.post("/apps/{app}/{action}")
def apps(app: str, action: str, confirm: bool = False, authorization: str = Header(None)):
    _auth(authorization)
    if app not in APPS or action not in ("up", "stop"): raise HTTPException(400, f"app in {APPS}, action up|stop")
    if action == "stop" and app == "dify": _need(confirm)
    p = subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(ROOT / "start.ps1"), app, action],
                       capture_output=True, text=True, timeout=600)
    return {"exit": p.returncode, "out": (p.stdout + p.stderr)[-3000:]}

@r.get("/apps/status")
def status(authorization: str = Header(None)):
    _auth(authorization)
    p = subprocess.run(["docker", "ps", "--format", "{{.Names}} {{.Status}}"], capture_output=True, text=True, timeout=60)
    return {"containers": p.stdout.splitlines()}

# --- OpenAI-compatible passthrough to the FreeLLMAPI desktop app (which only listens on 127.0.0.1),
# so Docker containers such as Dify can reach it at http://host.docker.internal:8765/v1.
from fastapi import Request
from fastapi.responses import StreamingResponse, Response

@r.api_route("/v1/{path:path}", methods=["GET", "POST"])
async def llm_proxy(path: str, request: Request):
    base = (E("FREELLMAPI_BASE_URL") or "http://127.0.0.1:31415/v1").rstrip("/")
    hdr = {k: v for k, v in request.headers.items() if k.lower() in ("authorization", "content-type", "accept")}
    body = await request.body()
    client = httpx.AsyncClient(timeout=300)
    req = client.build_request(request.method, f"{base}/{path}", params=request.query_params, content=body, headers=hdr)
    resp = await client.send(req, stream=True)
    ct = resp.headers.get("content-type", "")
    if "text/event-stream" in ct:
        async def gen():
            try:
                async for chunk in resp.aiter_raw(): yield chunk
            finally:
                await resp.aclose(); await client.aclose()
        return StreamingResponse(gen(), status_code=resp.status_code, media_type=ct)
    data = await resp.aread(); await resp.aclose(); await client.aclose()
    return Response(data, status_code=resp.status_code, media_type=ct or "application/json")
