import sys, json, base64, pathlib, httpx, os
sys.path.insert(0, r"C:\Users\henry\app-stack")
ROOT = pathlib.Path(r"C:\Users\henry\app-stack")
B = "http://localhost:8080/console/api"
S = ROOT / ".dify-session"
env = {}
for l in (ROOT / ".env").read_text().splitlines():
    if "=" in l and not l.startswith("#"): k, v = l.split("=", 1); env[k.strip()] = v.strip()
d = json.loads(S.read_text()); c = httpx.Client(timeout=300); c.cookies.update(d["cookies"]); c.headers["X-CSRF-Token"] = d["csrf"]
if d.get("bearer"): c.headers["Authorization"] = "Bearer " + d["bearer"]
def call(m, p, body=None):
    r = c.request(m, B + p, json=body); S.write_text(json.dumps({"cookies": dict(c.cookies) or d["cookies"], "csrf": d["csrf"], "bearer": d.get("bearer")}))
    return r
cmd = sys.argv[1]
if cmd == "tools":
    lfb = base64.b64encode(f"{env['LANGFUSE_PUBLIC_KEY']}:{env['LANGFUSE_SECRET_KEY']}".encode()).decode()
    T = {"stack-admin": ("bearer", "Authorization", env.get("BRIDGE_TOKEN")), "temporal-trigger": ("bearer", "Authorization", env.get("BRIDGE_TOKEN")),
         "github": ("bearer", "Authorization", env.get("GITHUB_TOKEN")), "cloudflare": ("bearer", "Authorization", env.get("CLOUDFLARE_API_TOKEN")),
         "coolify": ("bearer", "Authorization", env.get("COOLIFY_API_TOKEN")), "daytona": ("bearer", "Authorization", env.get("DAYTONA_API_KEY")),
         "loops": ("bearer", "Authorization", env.get("LOOPS_API_KEY")), "kapa": ("custom", "X-API-KEY", env.get("KAPA_API_KEY")),
         "postiz": ("custom", "Authorization", env.get("POSTIZ_API_KEY")), "langfuse": ("basic", "Authorization", lfb), "steel": ("none", "", "")}
    existing = {p["name"] for p in call("GET", "/workspaces/current/tool-providers?type=api").json()}
    for k, (pre, h, v) in T.items():
        cred = {"auth_type": "none"} if pre == "none" or not v else {"auth_type": "api_key", "api_key_header": h, "api_key_value": v, "api_key_header_prefix": pre}
        body = {"provider": k, "icon": {"content": "🔧", "background": "#FEF7C3"}, "credentials": cred, "schema_type": "openapi",
                "schema": (ROOT / "dify-tools" / f"{k}.json").read_text(), "privacy_policy": "", "custom_disclaimer": "", "labels": []}
        if k in existing:
            body["original_provider"] = k; r = call("POST", "/workspaces/current/tool-provider/api/update", body)
        else: r = call("POST", "/workspaces/current/tool-provider/api/add", body)
        print(k, cred["auth_type"], r.status_code, r.text[:200])
elif cmd == "raw":
    body = json.loads(pathlib.Path(sys.argv[4]).read_text()) if len(sys.argv) > 4 else None
    r = call(sys.argv[2], sys.argv[3], body); print(r.status_code, r.text[:int(os.getenv("N", "3000"))])
elif cmd == "model":
    P = "/workspaces/current/model-providers/langgenius/openai_api_compatible/openai_api_compatible"
    cred = {"api_key": env["FREELLMAPI_KEY"], "endpoint_url": "http://host.docker.internal:8765/v1", "mode": "chat",
            "context_size": "32000", "max_tokens_to_sample": "4096", "function_calling_type": "tool_call",
            "stream_function_calling": "supported", "vision_support": "no_support", "stream_mode_delimiter": "\\n\\n"}
    for path, body in [(P + "/models/credentials", {"model": "auto", "model_type": "llm", "credentials": cred, "name": "FreeLLMAPI"}),
                       (P + "/models", {"model": "auto", "model_type": "llm", "credentials": cred})]:
        r = call("POST", path, body); print(path, r.status_code, r.text[:400])
        if r.status_code < 300: break
    r = call("POST", "/workspaces/current/default-model", {"model_settings": [{"model_type": "llm", "provider": "langgenius/openai_api_compatible/openai_api_compatible", "model": "auto"}]})
    print("default", r.status_code, r.text[:300])
    r = call("GET", "/workspaces/current/default-model?model_type=llm"); print(r.status_code, r.text[:300])
elif cmd == "app":
    PROMPT = (ROOT / "dify-tools" / "console-prompt.md").read_text()
    apps = call("GET", "/apps?page=1&limit=50").json().get("data", [])
    app = next((a for a in apps if a["name"] == "Xevrion Stack Console"), None)
    if not app:
        app = call("POST", "/apps", {"name": "Xevrion Stack Console", "mode": "agent-chat", "icon_type": "emoji", "icon": "🛠️", "icon_background": "#FFEAD5", "description": "Console for the Xevrion app stack"}).json()
    aid = app["id"]; print("app", aid)
    provs = call("GET", "/workspaces/current/tool-providers?type=api").json()
    tools = []
    for p in provs:
        tl = call("GET", f"/workspaces/current/tool-provider/api/tools?provider={p['name']}").json()
        for t in tl:
            tools.append({"provider_id": p["id"], "provider_type": "api", "provider_name": p["name"], "tool_name": t["name"], "tool_label": t.get("label", {}).get("en_US", t["name"]), "tool_parameters": {}, "enabled": True})
    print("tools", len(tools))
    cfg = {"pre_prompt": PROMPT, "prompt_type": "simple", "opening_statement": "Xevrion Stack Console ready. What should I check or configure?",
           "model": {"provider": "langgenius/openai_api_compatible/openai_api_compatible", "name": "auto", "mode": "chat", "completion_params": {"temperature": 0.2}},
           "agent_mode": {"enabled": True, "strategy": "function_call", "max_iteration": 8, "tools": tools},
           "user_input_form": [], "dataset_configs": {"retrieval_model": "multiple", "datasets": {"datasets": []}}, "more_like_this": {"enabled": False},
           "suggested_questions": [], "suggested_questions_after_answer": {"enabled": False}, "speech_to_text": {"enabled": False}, "text_to_speech": {"enabled": False},
           "retriever_resource": {"enabled": False}, "sensitive_word_avoidance": {"enabled": False}, "file_upload": {"image": {"enabled": False}}}
    r = call("POST", f"/apps/{aid}/model-config", cfg); print("model-config", r.status_code, r.text[:300])
    tc = {"public_key": env["LANGFUSE_PUBLIC_KEY"], "secret_key": env["LANGFUSE_SECRET_KEY"], "host": "http://host.docker.internal:3000"}
    r = call("POST", f"/apps/{aid}/trace-config", {"tracing_provider": "langfuse", "tracing_config": tc}); print("trace-config", r.status_code, r.text[:300])
    if r.status_code >= 400:
        r = call("PATCH", f"/apps/{aid}/trace-config", {"tracing_provider": "langfuse", "tracing_config": tc}); print("trace-config patch", r.status_code, r.text[:300])
    r = call("POST", f"/apps/{aid}/trace", {"enabled": True, "tracing_provider": "langfuse"}); print("trace enable", r.status_code, r.text[:200])
    (ROOT / ".dify-app-id").write_text(aid)
elif cmd == "ask":
    aid = (ROOT / ".dify-app-id").read_text().strip()
    r = c.post(B + f"/apps/{aid}/chat-messages", json={"inputs": {}, "query": sys.argv[2], "response_mode": "streaming", "model_config": {}, "conversation_id": ""}, timeout=600)
    ans, tools = "", []
    for line in r.text.splitlines():
        if line.startswith("data:"):
            try: j = json.loads(line[5:])
            except Exception: continue
            if j.get("event") in ("agent_message", "message"): ans += j.get("answer", "")
            if j.get("event") == "agent_thought" and j.get("tool"): tools.append(j["tool"])
            if j.get("event") == "error": ans += " ERROR: " + j.get("message", "")
    print(r.status_code, "tools used:", sorted(set(tools)), "\nanswer:", ans[:1500] or r.text[:500])
elif cmd == "reinstall":
    import time
    pl = call("GET", "/workspaces/current/plugin/list?page=1&page_size=50").json()["plugins"]
    for p in pl:
        if p["plugin_id"] == "langgenius/openai_api_compatible":
            print("uninstall", call("POST", "/workspaces/current/plugin/uninstall", {"plugin_installation_id": p["id"]}).text[:200])
    ident = httpx.get("https://marketplace.dify.ai/api/v1/plugins/langgenius/openai_api_compatible").json()["data"]["plugin"]["latest_package_identifier"]
    t = call("POST", "/workspaces/current/plugin/install/marketplace", {"plugin_unique_identifiers": [ident]}).json(); print("install", t)
    tid = t.get("task_id")
    for i in range(60):
        if not tid: break
        time.sleep(10); s = call("GET", f"/workspaces/current/plugin/tasks/{tid}")
        st = s.json().get("task", {}).get("status") if s.status_code == 200 else s.status_code
        if st in ("success", "failed"): print("task", st, s.text[:400]); break
    print("providers", [p["provider"] for p in call("GET", "/workspaces/current/model-providers").json().get("data", [])])
