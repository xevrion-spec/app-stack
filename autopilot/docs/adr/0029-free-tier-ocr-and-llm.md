# ADR 0029: Free-tier OCR and LLM (FreeLLMAPI) with rules fallback

Status: accepted (2026-10-25)

## Decision
- **LLM.** FreeLLMAPI is the only LLM provider. It is reached through the existing OpenAI-compatible client (`LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL`). It does two jobs:
  1. Categorising bank lines the rules don't match. This path already existed. Confidence is calibrated to at most 0.9, and the result is schema-validated.
  2. Assisting receipt extraction (`LlmAssistedExtractor`). It is only asked when the rules are unsure. Its reply is untrusted: schema and sanity checks are applied, the rules win on any conflict, confidence is capped at 0.8, and the receipt **always** goes to review.

  On any error, timeout or invalid output, the rules result stands. **Guardrails (Daytona threat model):** the LLM never approves, posts or submits; receipt text is fenced as data, and the fence tags are stripped from it; amounts and dates are bounded.
- **OCR.** tesseract.js (Apache-2.0, free, local) via `TesseractOcr`. It runs in the Node local server (`OCR_ENGINE=tesseract npm run local`) and in the eval harness. Deployed Workers keep `MockOcr`, labelled mock: WASM plus language data doesn't fit sensibly in a free Worker.
- **Harnesses.** `scripts/eval-ocr.ts` scores 30 seeded synthetic receipt images. `scripts/eval-llm.ts` scores a held-out set of synthetic lines the rules don't match. Both write to `evals/results/`.

## Limits (honest)
- All accuracy figures are on synthetic data. The synthetic receipts are clean, computer-rendered images, much easier than real photos.
- FreeLLMAPI runs on Henry's PC (localhost), so a deployed Worker can't reach it. The test deployment therefore runs rules-only.
- Finding: the rules extractor takes the *last* amount after "total". Receipt text that says "total 999.99" further down can therefore fool the rules themselves. The LLM can't override rules figures, but this rules weakness remains (TODO).
