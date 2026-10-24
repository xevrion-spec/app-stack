"""Deterministic + LLM pipeline steps. Arithmetic is code; LLM only classifies/critiques."""
import csv, io, json
from common import llm, json_from, rule_category, dify_categorise, daytona_parse, CATS

STD = 0.20  # PLACEHOLDER from vat.json (verified:false). Verify on gov.uk.

def extract(bank_csv, receipts):
    rows, how = daytona_parse(bank_csv)
    if rows is None: rows = list(csv.DictReader(io.StringIO(bank_csv))); how = f"local ({how})"
    txns = [{"i": i, "date": r["date"], "desc": r["description"], "pence": int(round(float(r["amount"]) * 100))} for i, r in enumerate(rows)]
    return {"transactions": txns, "receipts": receipts, "parser": how}

def categorise(txns, use_dify=True):
    out, unknown = [], []
    for t in txns:
        rc = rule_category(t["desc"])
        if rc: out.append({**t, "code": rc[0], "category": rc[1], "confidence": rc[2], "method": "rule"})
        else: unknown.append(t)
    if unknown:
        lines = [{"i": t["i"], "desc": t["desc"], "pence": t["pence"]} for t in unknown]
        res = dify_categorise(lines) if use_dify else None; method = "dify"
        if not res:
            method = "llm"
            prompt = ("You are a UK bookkeeping assistant. Accounts: " + json.dumps([{"code": a["code"], "name": a["name"]} for a in CATS]) +
                      "\nAssign each bank line one account code. Use 9999 if unsure. Reply ONLY a JSON list of {\"i\":int,\"code\":str,\"confidence\":0-1}.\n" + json.dumps(lines))
            try: res = json_from(llm([{"role": "user", "content": prompt}])) or []
            except Exception as e: print("llm categorise failed:", e); res = []
        by = {int(r["i"]): r for r in res if "i" in r}
        names = {a["code"]: a["name"] for a in CATS}
        for t in unknown:
            r = by.get(t["i"], {"code": "9999", "confidence": 0})
            code = str(r.get("code", "9999")); code = code if code in names else "9999"
            out.append({**t, "code": code, "category": names[code], "confidence": float(r.get("confidence", 0)), "method": method})
    return sorted(out, key=lambda x: x["i"])

def reconcile(ledger, receipts):
    matched = 0
    for l in ledger:
        rc = next((r for r in receipts if abs(r["total_pence"]) == abs(l["pence"]) and r["date"] == l["date"]), None)
        l["receipt"] = rc["id"] if rc else None
        l["vat_pence"] = rc.get("vat_pence", 0) if rc else 0
        matched += bool(rc)
    return ledger, matched

def draft_vat(ledger):
    """Draft 9-box summary in pence. Simplified: only receipt-evidenced VAT; sales assumed standard-rated (PLACEHOLDER)."""
    sales = [l for l in ledger if l["code"] == "4000"]; purch = [l for l in ledger if l["code"] not in ("4000", "9999")]
    sales_gross = sum(l["pence"] for l in sales)
    box1 = round(sales_gross * STD / (1 + STD)); box6 = sales_gross - box1
    box4 = sum(l["vat_pence"] for l in purch); box7 = sum(-l["pence"] for l in purch) - box4
    return {"box1": box1, "box2": 0, "box3": box1, "box4": box4, "box5": box1 - box4, "box6": box6 // 100 * 100, "box7": box7 // 100 * 100,
            "box8": 0, "box9": 0, "_note": "DRAFT on unverified placeholder rules. Not for submission."}

def qa(ledger, vat):
    exc = []
    for l in ledger:
        if l["code"] == "9999" or l["confidence"] < 0.85:
            exc.append({"i": l["i"], "reason": f"low confidence ({l['confidence']:.2f}) for '{l['desc']}'", "severity": "medium"})
        if l["code"] != "4000" and l["pence"] < 0 and not l.get("receipt") and abs(l["pence"]) > 5000:
            exc.append({"i": l["i"], "reason": "purchase over £50 with no receipt", "severity": "low"})
    if vat["box3"] != vat["box1"] + vat["box2"] or vat["box5"] != vat["box3"] - vat["box4"]:
        exc.append({"reason": "VAT box arithmetic mismatch", "severity": "high"})
    score = round(1 - min(1, len([e for e in exc if e["severity"] != "low"]) / max(1, len(ledger))), 3)
    return score, exc
