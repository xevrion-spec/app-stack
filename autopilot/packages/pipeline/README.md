# Pipeline
`intake → extract → categorise → reconcile → draft → QA → (human review on exceptions) → deliver → outcome capture`

| Stage | Runs on | Tooling |
|---|---|---|
| intake | Edge API | R2 (documents), D1, Queue |
| extract | Temporal worker | Daytona sandbox for untrusted file parsing; LLM via FreeLLMAPI |
| categorise | Temporal worker | Rules first (`domain-uk-tax`), then LLM / Dify workflow |
| reconcile | Temporal worker | Match bank lines ↔ documents (amount/date/counterparty) |
| draft | Temporal worker | VAT box summary / SA figures from ledger (deterministic code, not LLM) |
| qa | Temporal worker | Deterministic checks + LLM critique; score to Langfuse |
| review | Web review queue | Only exceptions / low confidence |
| deliver | API + Loops (transactional email templates) | |
| outcome | D1 billing_events | Per-outcome billing signal |

Every stage emits a Langfuse span. Rule of thumb: **LLMs classify and explain; arithmetic is code.**
