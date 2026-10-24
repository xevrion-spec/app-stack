"""Local stack dashboard served by the bridge at /console.
Access: loopback only + one-time login link written by `start.ps1 console up` (HttpOnly session cookie).
Secrets never leave the server: config shows keys as set/missing only."""
import os, json, secrets, subprocess, pathlib, datetime, asyncio, re, shutil
import httpx
from fastapi import APIRouter, Request, HTTPException, Body
from fastapi.responses import HTMLResponse, RedirectResponse, JSONResponse

ROOT = pathlib.Path(__file__).resolve().parent.parent
ENV = ROOT / ".env"
OTP = ROOT / ".console-otp"
SESSIONS: set[str] = set()
r = APIRouter()
from dotenv import dotenv_values
E = lambda k, d="": (dotenv_values(ENV).get(k) or os.getenv(k, d) or d)  # re-read .env so key changes apply without restart
LOOP = {"127.0.0.1", "::1", "localhost"}

def guard(req: Request):
    if (req.client.host if req.client else "") not in LOOP:
        raise HTTPException(403, "console is only available from this computer")
    if req.cookies.get("xsc") not in SESSIONS:
        raise HTTPException(401, "not signed in: run .\\start.ps1 console up")

# ---------- app catalogue ----------
SECRETISH = re.compile(r"(KEY|TOKEN|SECRET|PASSWORD)$")
APPS = {
 "dify":       {"name": "Dify", "kind": "local", "docker": True, "url": "http://localhost:8080", "keys": ["DIFY_API_KEY", "DIFY_API_URL", "DIFY_CHAT_URL"]},
 "freellmapi": {"name": "FreeLLMAPI", "kind": "local", "url": "http://127.0.0.1:31415", "keys": ["FREELLMAPI_KEY", "FREELLMAPI_BASE_URL", "FREELLMAPI_MODEL", "OPENAI_API_KEY", "OPENAI_API_BASE"]},
 "langfuse":   {"name": "Langfuse", "kind": "local", "docker": True, "url": "http://localhost:3000", "keys": ["LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_HOST"]},
 "steel":      {"name": "Steel", "kind": "local", "docker": True, "url": "http://localhost:5173", "keys": ["STEEL_API_URL", "STEEL_UI_URL"]},
 "temporal":   {"name": "Temporal", "kind": "local", "docker": True, "url": "http://localhost:8233", "keys": ["TEMPORAL_ADDRESS", "TEMPORAL_NAMESPACE", "TEMPORAL_API_KEY"]},
 "daytona":    {"name": "Daytona", "kind": "cloud", "url": "https://app.daytona.io", "keys": ["DAYTONA_API_KEY", "DAYTONA_API_URL"]},
 "coolify":    {"name": "Coolify", "kind": "cloud", "url": "https://app.coolify.io", "keys": ["COOLIFY_API_TOKEN"]},
 "postiz":     {"name": "Postiz", "kind": "cloud", "url": "https://platform.postiz.com", "keys": ["POSTIZ_API_KEY", "POSTIZ_URL"]},
 "loops":      {"name": "Loops", "kind": "cloud", "url": "https://app.loops.so", "keys": ["LOOPS_API_KEY"]},
 "kapa":       {"name": "Kapa", "kind": "cloud", "url": "https://app.kapa.ai", "keys": ["KAPA_API_KEY", "KAPA_PROJECT_ID"]},
 "cloudflare": {"name": "Cloudflare", "kind": "cloud", "url": "https://dash.cloudflare.com", "keys": ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]},
 "github":     {"name": "GitHub", "kind": "cloud", "url": "https://github.com/xevrion-spec/app-stack", "keys": ["GITHUB_TOKEN"]},
 "crewai":     {"name": "CrewAI", "kind": "tool", "url": "https://docs.crewai.com", "keys": ["CREWAI_PYTHON", "FREELLMAPI_MODEL"]},
 "crawl4ai":   {"name": "Crawl4AI", "kind": "tool", "url": "https://docs.crawl4ai.com", "keys": ["CRAWL4AI_PYTHON"]},
 "aider":      {"name": "Aider", "kind": "tool", "url": "https://aider.chat/docs/", "keys": ["OPENAI_API_BASE", "OPENAI_API_KEY"]},
 "relume":     {"name": "Relume", "kind": "link", "url": "https://www.relume.io/app", "keys": []},
 "bolt":       {"name": "Bolt", "kind": "link", "url": "https://bolt.new", "keys": []},
}

def read_env():
    out = {}
    for l in ENV.read_text(encoding="utf-8").splitlines():
        m = re.match(r"^([A-Z0-9_]+)=(.*)$", l)
        if m: out[m.group(1)] = m.group(2).strip()
    return out

def write_env(key, value):
    lines = ENV.read_text(encoding="utf-8").splitlines(); done = False
    for i, l in enumerate(lines):
        if l.startswith(key + "="): lines[i] = f"{key}={value}"; done = True
    if not done: lines.append(f"{key}={value}")
    ENV.write_text("\n".join(lines) + "\n", encoding="utf-8"); os.environ[key] = value

def config(app):
    env = read_env()
    return [{"key": k, "set": bool(env.get(k)), "secret": bool(SECRETISH.search(k)),
             "value": None if SECRETISH.search(k) else env.get(k, "")} for k in APPS[app]["keys"]]

async def get(url, **kw):
    async with httpx.AsyncClient(timeout=20) as c:
        return await c.get(url, **kw)

def B(t): return {"Authorization": f"Bearer {t}"}

async def up(url):
    try:
        async with httpx.AsyncClient(timeout=4) as c: await c.get(url); return True
    except Exception: return False

# ---------- per-app stats (documented endpoints only) ----------
async def st_github():
    h = {**B(E("GITHUB_TOKEN")), "Accept": "application/vnd.github+json"}; b = "https://api.github.com/repos/xevrion-spec/app-stack"
    br, pr, cm = await asyncio.gather(get(b + "/branches", headers=h), get(b + "/pulls?state=open", headers=h), get(b + "/commits?per_page=5", headers=h))
    for x in (br, pr, cm): x.raise_for_status()
    return True, {"Branches": [x["name"] for x in br.json()], "Open PRs": len(pr.json()),
                  "Recent commits": [f'{c["sha"][:7]} {c["commit"]["message"].splitlines()[0][:60]}' for c in cm.json()]}
async def st_cloudflare():
    a = E("CLOUDFLARE_ACCOUNT_ID"); b = "https://api.cloudflare.com/client/v4/accounts/" + a; h = B(E("CLOUDFLARE_API_TOKEN"))
    w, p = await asyncio.gather(get(b + "/workers/scripts", headers=h), get(b + "/pages/projects", headers=h))
    w.raise_for_status()
    pages = [x["name"] for x in p.json().get("result") or []] if p.status_code == 200 else f"error {p.status_code}"
    return True, {"Workers": [x["id"] for x in w.json()["result"]], "Pages projects": pages}
async def st_coolify():
    b = "https://app.coolify.io/api/v1"; h = B(E("COOLIFY_API_TOKEN"))
    v, pr, sv = await asyncio.gather(get(b + "/version", headers=h), get(b + "/projects", headers=h), get(b + "/servers", headers=h))
    v.raise_for_status()
    return True, {"Version": v.text.strip('"'), "Projects": [x.get("name") for x in pr.json()] if pr.status_code == 200 else f"error {pr.status_code}",
                  "Servers": [x.get("name") for x in sv.json()] if sv.status_code == 200 else f"error {sv.status_code}"}
async def st_daytona():
    x = await get(E("DAYTONA_API_URL", "https://app.daytona.io/api").rstrip("/") + "/sandbox", headers=B(E("DAYTONA_API_KEY"))); x.raise_for_status()
    items = x.json()["items"] if isinstance(x.json(), dict) else x.json()
    return True, {"Sandboxes": len(items), "Names": [i.get("name") or i.get("id") for i in items][:10]}
async def st_steel():
    if not await up("http://localhost:3001/v1/health"): return False, {"Status": "stopped – start it below"}
    x = await get("http://localhost:3001/v1/sessions"); x.raise_for_status()
    s = x.json().get("sessions", [])
    return True, {"Health": "ok", "Sessions": len(s), "Statuses": sorted({i.get("status") for i in s})}
async def st_postiz():
    h = {"Authorization": E("POSTIZ_API_KEY")}; b = "https://api.postiz.com/public/v1"
    now = datetime.datetime.utcnow(); q = {"startDate": now.isoformat() + "Z", "endDate": (now + datetime.timedelta(days=30)).isoformat() + "Z"}
    i, p = await asyncio.gather(get(b + "/integrations", headers=h), get(b + "/posts", headers=h, params=q))
    i.raise_for_status()
    posts = p.json() if p.status_code == 200 else None
    n = len(posts.get("posts", posts)) if isinstance(posts, (dict, list)) else f"error {p.status_code}"
    return True, {"Connected channels": [f'{x.get("name")} ({x.get("identifier") or x.get("providerIdentifier")})' for x in i.json()] or "none yet",
                  "Scheduled posts (next 30 days)": n}
async def st_loops():
    h = B(E("LOOPS_API_KEY")); b = "https://app.loops.so/api/v1"
    k, l = await asyncio.gather(get(b + "/api-key", headers=h), get(b + "/lists", headers=h)); k.raise_for_status()
    return True, {"API status": "valid" if k.json().get("success") else "invalid", "Team": k.json().get("teamName"),
                  "Mailing lists": [x.get("name") for x in l.json()] if l.status_code == 200 else f"error {l.status_code}",
                  "Contacts": "Loops has no list-contacts endpoint; use the console to find a contact by email"}
async def st_kapa():
    x = await get(f"https://api.kapa.ai/query/v1/projects/{E('KAPA_PROJECT_ID')}/integrations/", headers={"X-API-KEY": E("KAPA_API_KEY")})
    if x.status_code != 200: return False, {"Error": f"HTTP {x.status_code} – check KAPA_PROJECT_ID (must be the project UUID)"}
    return True, {"Integrations": [i.get("name") or i.get("id") for i in (x.json() if isinstance(x.json(), list) else x.json().get("results", []))]}
async def st_langfuse():
    host = E("LANGFUSE_HOST", "http://localhost:3000")
    if not await up(host + "/api/public/health"): return False, {"Status": "stopped – start it below"}
    auth = (E("LANGFUSE_PUBLIC_KEY"), E("LANGFUSE_SECRET_KEY"))
    async with httpx.AsyncClient(timeout=20, auth=auth) as c:
        t, o = await asyncio.gather(c.get(host + "/api/public/traces", params={"limit": 1}), c.get(host + "/api/public/v2/observations", params={"limit": 100}))
    tr = t.json().get("meta", {}).get("totalItems") if t.status_code == 200 else f"error {t.status_code}"
    ob = len(o.json().get("data", [])) if o.status_code == 200 else f"error {o.status_code}"
    return True, {"Traces": tr, "Observations (latest 100)": ob}
async def st_temporal():
    try:
        from temporalio.client import Client
        c = await asyncio.wait_for(Client.connect(E("TEMPORAL_ADDRESS", "localhost:7233"), namespace=E("TEMPORAL_NAMESPACE", "default")), 6)
        wf = []
        async for w in c.list_workflows(page_size=10):
            wf.append(f"{w.id} · {w.workflow_type} · {w.status.name if w.status else '?'}")
            if len(wf) >= 10: break
        return True, {"Recent workflows": wf or "none"}
    except Exception as e:
        return False, {"Status": f"not reachable ({type(e).__name__}) – start it below"}
async def st_freellmapi():
    b = E("FREELLMAPI_BASE_URL").rstrip("/")
    x = await get(b + "/models", headers=B(E("FREELLMAPI_KEY"))); x.raise_for_status()
    return True, {"Models": len(x.json()["data"]), "Default model (Dify/console)": "llama-3.3-70b-fp8-fast", "Bridge model": E("FREELLMAPI_MODEL", "auto"), "Base URL": b}
async def st_dify():
    if not await up("http://localhost:8080/console/api/setup"): return False, {"Status": "stopped – start it below"}
    x = await get("http://localhost:8080/v1/info", headers=B(E("DIFY_API_KEY")))
    info = x.json() if x.status_code == 200 else {"error": x.status_code}
    return True, {"App": info.get("name", info), "Mode": info.get("mode"), "Chat URL": E("DIFY_CHAT_URL")}
def _pyver(py, mod):
    try:
        p = subprocess.run([py, "-c", f"import importlib.metadata as m;print(m.version('{mod}'))"], capture_output=True, text=True, timeout=60)
        return p.stdout.strip() or p.stderr.strip()[-200:]
    except Exception as e: return str(e)
async def st_crewai():
    v = await asyncio.to_thread(_pyver, E("CREWAI_PYTHON"), "crewai"); return bool(re.match(r"\d", v)), {"Version": v, "LLM": f'FreeLLMAPI ({E("FREELLMAPI_MODEL","auto")})', "Endpoint": "POST /crew/run"}
async def st_crawl4ai():
    v = await asyncio.to_thread(_pyver, E("CRAWL4AI_PYTHON"), "crawl4ai"); return bool(re.match(r"\d", v)), {"Version": v, "Endpoint": "POST /crawl"}
async def st_aider():
    exe = shutil.which("aider") or str(pathlib.Path.home() / ".local/bin/aider.exe")
    try: v = (await asyncio.to_thread(subprocess.run, [exe, "--version"], capture_output=True, text=True, timeout=60)).stdout.strip()
    except Exception as e: v = f"not found ({e})"
    return v.startswith("aider"), {"Version": v, "Config": ".aider.conf.yml " + ("present" if (ROOT / ".aider.conf.yml").exists() else "missing"), "Model": "openai/auto via FreeLLMAPI"}
async def st_link(): return True, {"Note": "No public API – open the app to work in it."}

STATS = {"github": st_github, "cloudflare": st_cloudflare, "coolify": st_coolify, "daytona": st_daytona, "steel": st_steel, "postiz": st_postiz,
         "loops": st_loops, "kapa": st_kapa, "langfuse": st_langfuse, "temporal": st_temporal, "freellmapi": st_freellmapi, "dify": st_dify,
         "crewai": st_crewai, "crawl4ai": st_crawl4ai, "aider": st_aider, "relume": st_link, "bolt": st_link}

# ---------- routes ----------
@r.get("/console/login")
def login(t: str, request: Request):
    if (request.client.host if request.client else "") not in LOOP: raise HTTPException(403)
    if not OTP.exists() or not secrets.compare_digest(OTP.read_text().strip(), t): raise HTTPException(401, "login link expired: run .\\start.ps1 console up again")
    OTP.unlink(); s = secrets.token_urlsafe(32); SESSIONS.add(s)
    resp = RedirectResponse("/console"); resp.set_cookie("xsc", s, httponly=True, samesite="strict"); return resp

@r.get("/console", response_class=HTMLResponse)
def page(request: Request):
    try: guard(request)
    except HTTPException as e: return HTMLResponse(f"<body style='background:#0b0f17;color:#ddd;font-family:sans-serif;padding:40px'><h2>Xevrion Stack Console</h2><p>{e.detail}</p></body>", status_code=e.status_code)
    return HTMLResponse((pathlib.Path(__file__).parent / "console.html").read_text(encoding="utf-8"))

@r.get("/console/api/apps")
def apps(request: Request):
    guard(request)
    return {"apps": [{"id": k, **{x: v[x] for x in ("name", "kind", "url")}, "docker": v.get("docker", False)} for k, v in APPS.items()],
            "chat_url": E("DIFY_CHAT_URL")}

@r.get("/console/api/app/{app}")
async def app_detail(app: str, request: Request):
    guard(request)
    if app not in APPS: raise HTTPException(404)
    try: ok, stats = await STATS[app]()
    except httpx.HTTPStatusError as e: ok, stats = False, {"Error": f"HTTP {e.response.status_code}: {e.response.text[:200]}"}
    except Exception as e: ok, stats = False, {"Error": f"{type(e).__name__}: {str(e)[:200]}"}
    return {"id": app, **APPS[app], "up": ok, "stats": stats, "config": config(app)}

@r.post("/console/api/app/{app}/{action}")
def control(app: str, action: str, request: Request, body: dict = Body(default={})):
    guard(request)
    if not body.get("confirm"): raise HTTPException(400, "confirm required")
    if not APPS.get(app, {}).get("docker") or action not in ("up", "stop"): raise HTTPException(400, "only local Docker apps can be started/stopped")
    p = subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(ROOT / "start.ps1"), app, action], capture_output=True, text=True, timeout=600)
    return {"exit": p.returncode, "out": (p.stdout + p.stderr)[-1500:]}

@r.post("/console/api/env")
def set_env(request: Request, body: dict = Body(...)):
    guard(request)
    k, v = str(body.get("key", "")), str(body.get("value", "")).strip()
    allowed = {x for a in APPS.values() for x in a["keys"]}
    if k not in allowed: raise HTTPException(400, "unknown key")
    if not body.get("confirm"): raise HTTPException(400, "confirm required")
    if "\n" in v or "\r" in v: raise HTTPException(400, "invalid value")
    write_env(k, v); return {"ok": True, "key": k, "set": bool(v)}

@r.get("/console/api/docker")
def docker(request: Request):
    guard(request)
    p = subprocess.run(["docker", "stats", "--no-stream", "--format", "{{.Name}}|{{.MemUsage}}"], capture_output=True, text=True, timeout=60)
    if p.returncode: return {"error": p.stderr.strip()[-300:]}
    rows = [l.split("|") for l in p.stdout.strip().splitlines() if "|" in l]
    def mib(s):
        n, u = re.match(r"([\d.]+)\s*([KMG]i?B)", s).groups(); return float(n) * {"KiB": 1/1024, "MiB": 1, "GiB": 1024, "KB": 1/1000, "MB": 1, "GB": 1000}.get(u, 1)
    used = sum(mib(m.split("/")[0]) for _, m in rows); limit = rows[0][1].split("/")[1].strip() if rows else "?"
    groups = {}
    for n, m in rows: g = n.split("-")[0]; groups[g] = groups.get(g, 0) + mib(m.split("/")[0])
    return {"containers": len(rows), "used_mib": round(used), "limit": limit, "by_project": {k: round(v) for k, v in sorted(groups.items(), key=lambda x: -x[1])}}


# ---------- Foundations panel (Autopilot back office on xevrion.co.uk) ----------
FOUND_HOSTS = ["api.xevrion.co.uk", "app.xevrion.co.uk", "docs.xevrion.co.uk", "status.xevrion.co.uk"]
FOUND_RES = {"d1": "autopilot-db", "r2": "autopilot-documents", "queues": ["autopilot-pipeline", "autopilot-pipeline-dlq"],
             "kv": "autopilot-config", "workers": ["autopilot-api", "autopilot-web"]}

@r.get("/console/api/foundations")
async def foundations(request: Request):
    guard(request)
    a = E("CLOUDFLARE_ACCOUNT_ID"); H = {"Authorization": "Bearer " + E("CLOUDFLARE_API_TOKEN")}; B = "https://api.cloudflare.com/client/v4"
    out = {"domain": "xevrion.co.uk", "hosts": [], "resources": {}, "ci": None, "todos": []}
    async with httpx.AsyncClient(timeout=20) as c:
        async def cf(p):
            try: return (await c.get(B + p, headers=H)).json().get("result")
            except Exception as e: return {"error": str(e)}
        doms = await cf(f"/accounts/{a}/workers/domains") or []
        for h in FOUND_HOSTS:
            svc = next((d.get("service") for d in doms if isinstance(d, dict) and d.get("hostname") == h), None)
            try: code = (await c.get(f"https://{h}/", follow_redirects=False)).status_code
            except Exception as e: code = type(e).__name__
            out["hosts"].append({"host": h, "worker": svc, "http": code})
        scripts = [s["id"] for s in (await cf(f"/accounts/{a}/workers/scripts") or []) if isinstance(s, dict)]
        d1 = [x["name"] for x in (await cf(f"/accounts/{a}/d1/database") or []) if isinstance(x, dict)]
        r2 = [x["name"] for x in ((await cf(f"/accounts/{a}/r2/buckets")) or {}).get("buckets", [])]
        qs = [x["queue_name"] for x in (await cf(f"/accounts/{a}/queues") or []) if isinstance(x, dict)]
        kv = [x["title"] for x in (await cf(f"/accounts/{a}/storage/kv/namespaces") or []) if isinstance(x, dict)]
        out["resources"] = {"workers": {w: w in scripts for w in FOUND_RES["workers"]}, "d1": {FOUND_RES["d1"]: FOUND_RES["d1"] in d1},
                            "r2": {FOUND_RES["r2"]: FOUND_RES["r2"] in r2}, "queues": {q: q in qs for q in FOUND_RES["queues"]},
                            "kv": {FOUND_RES["kv"]: FOUND_RES["kv"] in kv}}
        try:
            g = (await c.get("https://api.github.com/repos/xevrion-spec/app-stack/actions/runs", params={"branch": "foundation/autopilot-backoffice", "per_page": 3},
                             headers={"Authorization": "Bearer " + E("GITHUB_TOKEN"), "Accept": "application/vnd.github+json"})).json()
            out["ci"] = [{"name": x["name"], "status": x["status"], "conclusion": x["conclusion"], "url": x["html_url"]} for x in g.get("workflow_runs", [])]
        except Exception as e: out["ci"] = {"error": str(e)}
    f = ROOT / "FOUNDATIONS.md"
    if f.exists(): out["todos"] = [l.strip()[5:].strip() for l in f.read_text(encoding="utf-8").splitlines() if l.strip().startswith("- [ ]")]
    ev = ROOT / "repo" / "autopilot" / "evals" / "results" / "latest.json"
    if ev.exists(): out["last_eval"] = {k: v for k, v in json.loads(ev.read_text()).items() if k in ("accuracy", "threshold")}
    return out

@r.get("/console/foundations", response_class=HTMLResponse)
def foundations_page(request: Request):
    guard(request)
    return HTMLResponse("""<!doctype html><meta charset=utf-8><title>Foundations</title>
<style>body{background:#0b0f17;color:#dde;font-family:system-ui;padding:24px;max-width:980px;margin:auto}table{border-collapse:collapse;width:100%;margin:8px 0 20px}
td,th{border-bottom:1px solid #223;padding:6px;text-align:left}.ok{color:#5d5}.bad{color:#e66}a{color:#8af}h2{margin-top:28px}</style>
<a href="/console">&larr; Console</a><h1>Foundations &middot; Xevrion Autopilot</h1><div id=o>Loading&hellip;</div>
<script>const y=v=>v?'<span class=ok>yes</span>':'<span class=bad>no</span>';
fetch('/console/api/foundations').then(r=>r.json()).then(d=>{let h=`<p>Domain: <b>${d.domain}</b>${d.last_eval?` &middot; last eval accuracy <b>${d.last_eval.accuracy}</b> (gate ${d.last_eval.threshold})`:''}</p>`;
h+='<h2>Hostnames</h2><table><tr><th>Host</th><th>Worker</th><th>HTTP</th></tr>'+d.hosts.map(x=>`<tr><td><a href="https://${x.host}" target=_blank>${x.host}</a></td><td>${x.worker||'-'}</td><td>${x.http}</td></tr>`).join('')+'</table>';
h+='<h2>Cloudflare resources</h2><table>'+Object.entries(d.resources).map(([k,v])=>Object.entries(v).map(([n,ok])=>`<tr><td>${k}</td><td>${n}</td><td>${y(ok)}</td></tr>`).join('')).join('')+'</table>';
h+='<h2>CI (foundation/autopilot-backoffice)</h2><table>'+(Array.isArray(d.ci)&&d.ci.length?d.ci.map(x=>`<tr><td>${x.name}</td><td>${x.status}</td><td>${x.conclusion||''}</td><td><a href="${x.url}" target=_blank>run</a></td></tr>`).join(''):'<tr><td>No runs yet</td></tr>')+'</table>';
h+='<h2>Open TODOs (FOUNDATIONS.md)</h2><ul>'+d.todos.map(t=>`<li>${t.replace(/</g,'&lt;')}</li>`).join('')+'</ul>';o.innerHTML=h}).catch(e=>o.textContent='Error: '+e)</script>""")
