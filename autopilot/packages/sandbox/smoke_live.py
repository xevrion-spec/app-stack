"""LIVE smoke test: creates and deletes exactly ONE sandbox (costs a tiny amount of credit). Run manually only."""
import sys, pathlib, json
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "local")); import common
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from sandbox.parser_job import parse_in_sandbox
from sandbox.guard import GuardedDaytona
g = GuardedDaytona()
res = parse_in_sandbox(b"date,description,amount\n2026-07-01,TEST,1.00\n", "smoke.csv", "smoke-test", g)
import time
for _ in range(15):  # deletion is asynchronous on Daytona; wait for it to disappear
    if not g.ours(): break
    time.sleep(2)
print(json.dumps({"rows": len(res["rows"]), "parser": res["parser"], "ours_after": len(g.ours()), "account_total_after": len(list(g.client.list()))}))
assert res["rows"] and len(g.ours()) == 0
