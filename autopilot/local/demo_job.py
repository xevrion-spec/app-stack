"""End-to-end demo job on SYNTHETIC data. Prints categorised ledger, draft VAT summary, QA score; traces to Langfuse."""
import json, pathlib, sys, time
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from common import langfuse, E
import pipeline as P
SAMPLE = pathlib.Path(__file__).parent / "sample"

def load_sample():
    return (SAMPLE / "bank.csv").read_text(), json.loads((SAMPLE / "receipts.json").read_text())

def run(bank_csv, receipts, job_name="demo-job", use_dify=True):
    lf = langfuse(); tr = lf.trace(name="autopilot-job", metadata={"job": job_name, "synthetic": True}) if lf else None
    def span(name, inp, fn):
        s = tr.span(name=name, input=inp) if tr else None; t = time.time()
        out = fn()
        if s: s.end(output=out if not isinstance(out, tuple) else list(out), metadata={"ms": int((time.time()-t)*1000)})
        return out
    ex = span("extract", {"bytes": len(bank_csv), "receipts": len(receipts)}, lambda: P.extract(bank_csv, receipts))
    led = span("categorise", {"n": len(ex["transactions"])}, lambda: P.categorise(ex["transactions"], use_dify))
    led, matched = span("reconcile", {"n": len(led)}, lambda: P.reconcile(led, receipts))
    vat = span("draft", {"ledger_lines": len(led)}, lambda: P.draft_vat(led))
    score, exc = span("qa", {"vat": vat}, lambda: P.qa(led, vat))
    review = [e for e in exc if e["severity"] != "low"]
    span("review", {"exceptions": len(review)}, lambda: {"routed_to_human": len(review)})
    span("deliver", {}, lambda: {"delivered": False, "note": "demo: no email sent (Loops template only)"})
    span("outcome", {}, lambda: {"billable": score >= 0.85 and not any(e["severity"] == "high" for e in exc)})
    if tr:
        tr.update(output={"qa_score": score, "exceptions": len(exc)}); tr.score(name="qa_score", value=score); lf.flush()
    url = f"{E('LANGFUSE_HOST','http://localhost:3000')}/trace/{tr.id}" if tr else None
    return {"ledger": led, "matched_receipts": matched, "vat": vat, "qa_score": score, "exceptions": exc, "parser": ex["parser"], "trace_url": url}

if __name__ == "__main__":
    b, r = load_sample(); res = run(b, r, use_dify="--no-dify" not in sys.argv)
    out = pathlib.Path(__file__).parent / "out"; out.mkdir(exist_ok=True)
    (out / "demo_result.json").write_text(json.dumps(res, indent=2))
    for l in res["ledger"]: print(f"{l['date']}  {l['desc'][:32]:32} {l['pence']/100:>9.2f}  {l['code']} {l['category'][:22]:22} {l['confidence']:.2f} {l['method']}")
    print("VAT draft (pence):", {k: v for k, v in res["vat"].items() if k.startswith("box")})
    print("QA score:", res["qa_score"], "| exceptions:", len(res["exceptions"]), "| parser:", res["parser"], "| trace:", res["trace_url"])
