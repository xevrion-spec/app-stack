"""Accuracy gate. Scores categorisation on golden cases; logs to Langfuse; exits 1 below threshold.
Usage: python evals/run_evals.py [--offline] [--threshold 0.8]"""
import json, sys, pathlib
HERE = pathlib.Path(__file__).parent; sys.path.insert(0, str(HERE.parent / "local"))
offline = "--offline" in sys.argv
thr = float(sys.argv[sys.argv.index("--threshold") + 1]) if "--threshold" in sys.argv else 0.8
if offline:
    import os; os.environ["DIFY_API_KEY"] = ""
from common import langfuse
import pipeline as P
cases = [json.loads(l) for l in (HERE / "golden" / "categorise.jsonl").read_text().splitlines() if l.strip()]
txns = [{"i": i, "date": "2026-07-01", "desc": c["desc"], "pence": c["pence"]} for i, c in enumerate(cases)]
if offline:  # rules only, unknowns -> 9999 (CI without LLM access)
    import common; P.llm = lambda *_a, **_k: "[]"
got = P.categorise(txns, use_dify=False)
ok = 0; rows = []
for c, g in zip(cases, got):
    exp = c["expect"] if isinstance(c["expect"], list) else [c["expect"]]
    hit = g["code"] in exp; ok += hit; rows.append({"desc": c["desc"], "expect": exp, "got": g["code"], "method": g["method"], "pass": hit})
acc = ok / len(cases)
lf = None if offline else langfuse()
if lf:
    t = lf.trace(name="eval:categorise", input={"cases": len(cases)}, output={"accuracy": acc, "rows": rows}); t.score(name="accuracy", value=acc); lf.flush()
out = HERE / "results"; out.mkdir(exist_ok=True); (out / "latest.json").write_text(json.dumps({"accuracy": acc, "threshold": thr, "rows": rows}, indent=2))
for r in rows: print(("PASS " if r["pass"] else "FAIL ") + f"{r['desc'][:34]:34} expect={r['expect']} got={r['got']} ({r['method']})")
print(f"accuracy={acc:.3f} threshold={thr} -> {'PASS' if acc >= thr else 'FAIL'}")
sys.exit(0 if acc >= thr else 1)
