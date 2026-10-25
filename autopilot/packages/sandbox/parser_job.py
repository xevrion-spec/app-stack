"""Document parsing job contract.
IN : one file (bytes) + filename + tenant id. No secrets, no env vars, no network.
OUT: {"ok": bool, "kind": "bank_csv"|"unsupported", "rows": [...], "parser": "daytona"|"local", "error": str|None}
Tenant data is wiped after: the sandbox is ephemeral and deleted in a finally block."""
from __future__ import annotations
import csv, io, json
from .guard import GuardedDaytona

PARSER_SRC = r"""
import csv, io, json, sys
data = open('/tmp/in/input', 'rb').read().decode('utf-8', 'replace')
rows = list(csv.DictReader(io.StringIO(data)))
open('/tmp/out.json', 'w').write(json.dumps({"ok": True, "kind": "bank_csv", "rows": rows}))
print(len(rows))
"""

def parse_local(data: bytes, filename: str) -> dict:
    if not filename.lower().endswith(".csv"): return {"ok": False, "kind": "unsupported", "rows": [], "parser": "local", "error": "only CSV supported yet"}
    return {"ok": True, "kind": "bank_csv", "rows": list(csv.DictReader(io.StringIO(data.decode("utf-8", "replace")))), "parser": "local", "error": None}

def parse_in_sandbox(data: bytes, filename: str, tenant: str, guard: GuardedDaytona | None = None) -> dict:
    g = guard or GuardedDaytona()
    with g.sandbox(tenant, "parse") as sb:
        g.exec(sb, "mkdir -p /tmp/in")
        g.upload(sb, data, "/tmp/in/input")
        g.upload(sb, PARSER_SRC.encode(), "/tmp/parse.py")
        g.exec(sb, "python3 /tmp/parse.py")
        out = json.loads(g.download(sb, "/tmp/out.json"))
    out.update(parser="daytona", error=None); return out

def parse(data: bytes, filename: str, tenant: str, guard: GuardedDaytona | None = None, allow_sandbox=True) -> dict:
    """Sandbox first (if allowed and within budget), local fallback otherwise. Never raises for sandbox issues."""
    if allow_sandbox and filename.lower().endswith(".csv"):
        try: return parse_in_sandbox(data, filename, tenant, guard)
        except Exception as e:
            r = parse_local(data, filename); r["error"] = f"sandbox fallback: {type(e).__name__}: {str(e)[:160]}"; return r
    return parse_local(data, filename)
