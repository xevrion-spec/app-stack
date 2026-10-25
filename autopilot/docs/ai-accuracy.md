# AI accuracy: real runs on synthetic data (25 Oct 2026)

Everything here is **synthetic**. These numbers show the code path works; they do not predict accuracy on real client data.

## Bank-line categorisation, held-out set (FreeLLMAPI, model `auto`)
- **Script:** `scripts/eval-llm.ts`.
- **Data:** `evals/golden/holdout.jsonl`, 40 lines written separately from the rules. 7 were excluded because the rules already match them, leaving 33 genuine unknowns: 29 with a correct code and 4 that must go to review (including a prompt-injection line).

| Run | Code accuracy (29) | Review cases flagged | Silent errors* | Invalid replies | Time per batch |
| --- | --- | --- | --- | --- | --- |
| Rules only | 0% (all to suspense) | 4/4 | 0 | n/a | <0.1 s |
| Before fix: bare codes in prompt (3 runs) | 6.9–17.2% | 3/4 | 1 (injection → Sales, 0.85, unflagged) | 0 | 17–38 s |
| **After fix: names in prompt, LLM always reviewed (3 runs)** | **75.9% / 82.8% / 86.2% (mean 81.6%)** | **4/4** | **0** | 0 | 23–45 s |

\*Silent error = wrong code **and** not flagged for review.

**Fixes this eval forced:**
1. The prompt listed bare account codes, so the model guessed what they meant. It now lists names.
2. LLM answers could reach 0.85, which equals the review threshold, so they bypassed review. Every LLM categorisation is now a suggestion needing human approval.

**Remaining misses:** professional memberships (ICAEW, AAT) put under Software, insurance under Office, and a Clearpay settlement sent to suspense. All were flagged.

## Receipts: OCR (tesseract.js, local, free) plus extraction
- **Script:** `scripts/eval-ocr.ts`.
- **Data:** 30 seeded synthetic receipt images (`evals/receipts`), clean renders with slight rotation and blur.

| Extractor | Total | VAT | Date | Vendor | All of total, VAT, date | Wrong but flagged | Wrong and not flagged |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Rules | 100% | 100% | 90% | 93.3% | 90% | 3/3 | 0 |
| Rules + FreeLLMAPI | 100% | 100% | 90% | 93.3% | 90% | 3/3 | 0 |

Mean OCR confidence was 0.94. The LLM added nothing on these clean receipts: the rules were already right, or the LLM's dates conflicted and the rules won. Real phone photos will be much harder. **There is no real-photo benchmark.**

## Where each piece runs
| Piece | Local (`npm run local`) | Test deployment (Workers) |
| --- | --- | --- |
| Rules categorisation and extraction | real | real |
| FreeLLMAPI | real when `LLM_*` is set | **not available**: FreeLLMAPI is on localhost |
| OCR | real with `OCR_ENGINE=tesseract` | **mock** (`MockOcr`) |
