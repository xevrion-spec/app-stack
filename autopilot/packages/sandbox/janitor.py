"""Delete stale Xevrion sandboxes. Usage: python packages/sandbox/janitor.py [--max-age 15] [--dry-run]"""
import sys, pathlib, json
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "local")); import common  # loads .env
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from sandbox.guard import GuardedDaytona
a = sys.argv; age = int(a[a.index("--max-age") + 1]) if "--max-age" in a else None
g = GuardedDaytona(); res = g.janitor(age, dry_run="--dry-run" in a)
print(json.dumps({"ours_remaining": len(g.ours()), "all_in_account": len(list(g.client.list())), "actions": res, "usage": g.usage.summary()}, indent=2))
