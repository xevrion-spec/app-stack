# ADR 0026 — Practice intelligence: learning, anomalies, accuracy harness, drift, assistant

Status: accepted (2026-10-25). Migration 0014 (+down).

- **Learning with provenance:** rules are re-derived from reviewer corrections in `review_log` (auto-approvals are
  excluded). A pattern becomes a FIRM-WIDE rule only when at least 2 clients agree independently; otherwise it is a
  client rule. Every rule lists the review ids that produced it. Managers can disable a rule, and re-derivation never
  re-enables a disabled one. Suggestions prefer client rules and carry reason codes (`learned_client_rule` /
  `learned_practice_rule`), a confidence and evidence ids.
- **Anomalies (pure, `packages/books/src/intelligence.ts`):** duplicate payments (same amount and payee within 7 days),
  missing receipts (over £250 with no document of kind `receipt`; a bank row's `document_id` is the statement, not a
  receipt), unusual VAT (zero-rated with VAT, or more than 2% off the rate), round sums (£500+), and weekend postings. Each
  has a severity, confidence, reason and evidence. Dismissals need a note and are audited.
- **Accuracy harness:** the share of human-reviewed items whose AI category survived review, by month, client and
  confidence band, with calibration gap and top confusions. This is an honest metric only once real accountants review
  real data; on synthetic data it only proves the plumbing.
- **Drift:** an accuracy drop of more than 5pp vs a 90-day baseline (needs 20+ items in each window), overconfidence
  (mean confidence more than 10pp above accuracy), and a QA failure rate above 5%.
- **Practice assistant:** deterministic regex intent routing first. A MOCK LLM router (`services/llm-router.ts`) is the
  fallback and may only return one of 9 known intents; it never produces text or sees data. Answers are computed from
  ledger tables through `clientScopeSql`/`accessibleClient`, so a router, even a malicious one, cannot widen scope.
  Every answer has citations (API paths and ids), and every question is audited.
