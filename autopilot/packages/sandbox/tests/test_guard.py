"""Mocked tests: no network, no credit. Run: python -m pytest packages/sandbox/tests -q  (or python packages/sandbox/tests/test_guard.py)"""
import sys, pathlib, json, tempfile, datetime, types
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
from sandbox.guard import GuardedDaytona, SandboxConfig, Usage, BudgetExceeded, ConcurrencyExceeded, LABEL_APP
from sandbox import parser_job

class FakeSB:
    def __init__(s, i, labels, created=None):
        s.id = i; s.labels = labels; s.created_at = (created or datetime.datetime.now(datetime.timezone.utc)).isoformat(); s.files = {}
        s.process = types.SimpleNamespace(exec=s._exec); s.fs = types.SimpleNamespace(upload_file=s._up, download_file=lambda p: s.files[p])
    def _up(s, data, p): s.files[p] = data
    def _exec(s, cmd, timeout=None):
        if "parse.py" in cmd:
            import csv, io
            rows = list(csv.DictReader(io.StringIO(s.files["/tmp/in/input"].decode())))
            s.files["/tmp/out.json"] = json.dumps({"ok": True, "kind": "bank_csv", "rows": rows}).encode()
        return types.SimpleNamespace(exit_code=0, result="ok")
class FakeClient:
    def __init__(s): s.sbs = []; s.n = 0
    def list(s, *a, **k): return list(s.sbs)
    def create(s, params):
        s.n += 1; sb = FakeSB(f"sb{s.n}", params.labels); s.sbs.append(sb); return sb
    def delete(s, sb): s.sbs = [x for x in s.sbs if x.id != sb.id]

def mk(**over):
    cfg = SandboxConfig(**over); tmp = pathlib.Path(tempfile.mkdtemp()) / "u.json"
    return GuardedDaytona(cfg, client=FakeClient(), usage=Usage(tmp))

def test_create_always_deletes_and_counts():
    g = mk()
    try:
        with g.sandbox("Tenant A", "parse") as sb: assert sb.labels["tenant"] == "tenant-a"; raise ValueError("boom")
    except ValueError: pass
    assert g.client.sbs == [] and g.usage.today() == 1

def test_params_are_locked_down():
    p = mk()._params("t", "parse")
    assert p.network_block_all and p.ephemeral and p.env_vars == {} and not p.public and p.labels["app"] == LABEL_APP

def test_daily_budget_cap():
    g = mk(max_creates_per_day=1)
    with g.sandbox("t", "p"): pass
    try:
        with g.sandbox("t", "p"): pass
        assert False
    except BudgetExceeded: pass

def test_concurrency_cap():
    g = mk(max_concurrent=1); g.client.sbs.append(FakeSB("x", {"app": LABEL_APP}))
    try: g.check_limits(); assert False
    except ConcurrencyExceeded: pass

def test_janitor_only_deletes_old_ours():
    g = mk(); old = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=2)
    g.client.sbs += [FakeSB("old", {"app": LABEL_APP}, old), FakeSB("new", {"app": LABEL_APP}), FakeSB("other", {"app": "someone-else"}, old)]
    res = g.janitor(15); assert [r[0] for r in res] == ["old"] and {s.id for s in g.client.sbs} == {"new", "other"}

def test_parse_contract_and_fallback():
    g = mk(); out = parser_job.parse(b"date,description,amount\n2026-07-01,X,1\n", "a.csv", "t", g)
    assert out["parser"] == "daytona" and out["rows"][0]["description"] == "X" and g.client.sbs == []
    g2 = mk(max_creates_per_day=0); out2 = parser_job.parse(b"date,description,amount\n2026-07-01,Y,1\n", "a.csv", "t", g2)
    assert out2["parser"] == "local" and "BudgetExceeded" in out2["error"]

if __name__ == "__main__":
    for k, f in list(globals().items()):
        if k.startswith("test_"): f(); print("PASS", k)
