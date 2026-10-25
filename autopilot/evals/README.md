# Evals

Two gates:

- **`npm run evals`** (`scripts/evals.ts`): the gate for the TypeScript pipeline the API actually runs. CI runs it offline (rules only, deterministic) at `--threshold 0.9`. With `LLM_BASE_URL` set, unknown lines go to the LLM like production; with `LANGFUSE_*` set the run is traced and scored.
  - `golden/cases.jsonl`: 68 categorisation cases tagged routine, wholesale_vs_sale, token_boundary, refund, sign, transfer, split, fx, unknown. `review: true` means the correct behaviour is to ask a human (the line must raise an exception), not to guess.
  - `golden/scenarios.json`: reconciliation (late invoice payment, amount mismatch, identical receipts, split payment) and VAT (standard with refund + transfer, flat rate) scenarios.
  - Latest: accuracy 1.000 (75 cases). Caveat: these cases were written alongside the rules, so the score shows the rules behave as designed; it does not predict accuracy on real bank data.
- `run_evals.py`: the original Python gate for the local Dify/FreeLLMAPI prototype (12 cases), kept for the bridge.

Add a golden case for every exception a human corrects in production.
