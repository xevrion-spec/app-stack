# Practice benchmark: Autopilot (practice co-pilot) vs UK practice software

_Researched 25 Oct 2026 from vendor pages and third parties (sources at the end). Prices exclude VAT. Scores are my judgement against the evidence, 0–10._

**Scoring rules.** Autopilot is scored as it exists today: `feature/practice-copilot` at M7 (5628846).

- Mocks count as missing.
- Unverified tax rules count heavily against it.
- There is no deployment, no customer and no support.

The sole-trader benchmark (`competitive-benchmark.md`, 2.7/10) is a different rubric. It is re-scored at the end so the two can be compared.

## Weights (what a 5–50 person UK practice needs)

| Metric                         | Weight | A 10 means                                                            |
| ------------------------------ | ------ | --------------------------------------------------------------------- |
| Compliance filing              | 15     | HMRC-recognised filing: MTD VAT/ITSA, SA, CT600, iXBRL final accounts |
| Client ledger/bank data        | 12     | Live GL connections (Xero/QBO/Sage) and Open Banking via an FCA route |
| Workflow / practice management | 10     | Jobs, deadlines, tasks, time, WIP, billing, email                     |
| AI automation                  | 10     | Proven categorisation/anomaly/agent work on real client data          |
| Client portal & onboarding     | 8      | Portal, requests, engagement + e-sign, AML/KYC, real delivery         |
| Review, QA & audit trail       | 8      | Four-eyes, working papers, tamper-evident trail                       |
| Customers / trust              | 8      | Large installed base, reviews, funding                                |
| Capture / OCR                  | 7      | Accurate receipts, invoices and statements at scale                   |
| Integrations / API             | 6      | Live ecosystem plus a public API                                      |
| Price / value                  | 6      | Cheap or free for firms                                               |
| Security & compliance posture  | 6      | Live auth, pentest, certifications, UK GDPR processes                 |
| Support                        | 4      | Responsive UK support                                                 |

## Scores

| Product                                        | Filing 15 | Data 12 | Workflow 10 | AI 10 | Portal 8 | Review 8 | Trust 8 | Capture 7 | API 6 | Price 6 | Security 6 | Support 4 | **/10** |
| ---------------------------------------------- | --------- | ------- | ----------- | ----- | -------- | -------- | ------- | --------- | ----- | ------- | ---------- | --------- | ------- |
| Xero Partner Hub + Practice Mgmt               | 8         | 10      | 8           | 5     | 5        | 6        | 10      | 7         | 9     | 9       | 9          | 7         | **7.8** |
| Sage for Accountants                           | 9         | 8       | 6           | 5     | 4        | 6        | 9       | 6         | 6     | 10      | 9          | 7         | **7.1** |
| Intuit Accountant Suite (ex-QBOA)              | 5         | 9       | 6           | 6     | 5        | 6        | 10      | 6         | 8     | 10      | 9          | 7         | **7.0** |
| IRIS Elements                                  | 10        | 4       | 7           | 3     | 6        | 6        | 9       | 3         | 4     | 7       | 8          | 6         | **6.3** |
| Pennylane (FR; UK filing 0)                    | 0         | 8       | 7           | 7     | 8        | 7        | 8       | 8         | 7     | 6       | 7          | 6         | **6.2** |
| TaxDome                                        | 1         | 5       | 9           | 5     | 10       | 5        | 8       | 4         | 5     | 6       | 7          | 6         | **5.6** |
| Karbon                                         | 0         | 5       | 10          | 6     | 7        | 5        | 8       | 2         | 7     | 5       | 8          | 7         | **5.4** |
| Dext (practice)                                | 0         | 6       | 3           | 7     | 4        | 5        | 9       | 10        | 7     | 6       | 8          | 6         | **5.4** |
| Basis (US, AI agents)                          | 2         | 7       | 4           | 9     | 2        | 7        | 7       | 6         | 5     | 4       | 7          | 6         | **5.3** |
| AutoEntry (Sage)                               | 0         | 5       | 1           | 5     | 2        | 3        | 7       | 9         | 5     | 7       | 7          | 5         | **4.1** |
| **Autopilot (with real-world steps, 6–12 mo)** | 5         | 8       | 7           | 6     | 7        | 8        | 2       | 6         | 7     | 6       | 6          | 4         | **6.1** |
| **Autopilot TODAY**                            | 1         | 2       | 6           | 4     | 5        | 7        | 0       | 1         | 5     | 3       | 3          | 0         | **3.1** |

Arithmetic for today: 15·1 + 12·2 + 10·6 + 10·4 + 8·5 + 8·7 + 8·0 + 7·1 + 6·5 + 6·3 + 6·3 + 4·0 = 308, giving **3.08**.

## Autopilot today: why each score

| Metric   | Score | Evidence                                                                                                                                                                                                                                                                                           |
| -------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Filing   | 1     | Calculates VAT boxes, validates returns and builds fraud-prevention headers. The HMRC adapter is a MOCK, not recognised, with no credentials. Rates and deadlines are UNVERIFIED. No SA, CT600 or iXBRL.                                                                                           |
| Data     | 2     | Bank CSV/OFX/QIF/MT940 and Xero/QBO/FreeAgent CSV imports are real and fuzz-tested (importer mutation score 93.2%). Xero, QBO, FreeAgent and Open Banking connectors are MOCK adapters behind contract tests.                                                                                      |
| Workflow | 6     | Real and tested: client health, review queue with SLA, bulk approve with preview and confirm, close checklists, queries, recurring tasks, time, WIP and internal billing records. No email integration and no capacity planning.                                                                   |
| AI       | 4     | Deterministic, explainable: learned rules with provenance, anomaly detection, accuracy harness, drift alerts and a cited, permission-scoped assistant. The LLM router is a mock. Only measured on synthetic data.                                                                                  |
| Portal   | 5     | Real portal with separate auth, document requests with upload, query answers, and engagement acceptance by sha256. Web screens and e2e exist. Magic-link delivery is a MOCK (the code is shown to staff). No AML/KYC. The e-sign provider is an interface only. The upload malware scan is a stub. |
| Review   | 7     | Four-eyes immutable working papers, refused if the ledger changed. Hash-chained practice audit log that verifies after backup and restore. Per-client audit export.                                                                                                                                |
| Trust    | 0     | No customers, firms or funding.                                                                                                                                                                                                                                                                    |
| Capture  | 1     | Upload and de-dupe are real. OCR is a mock.                                                                                                                                                                                                                                                        |
| API      | 5     | OpenAPI with typed SDK, scoped keys and signed webhooks. Zero live third-party integrations.                                                                                                                                                                                                       |
| Price    | 3     | Nothing purchasable. Plan caps are placeholders.                                                                                                                                                                                                                                                   |
| Security | 3     | Engineering: authz matrices (every practice and portal op × role × other firm), coverage 96.6%/88.8%, mutation testing, gitleaks, CSP with no `unsafe-inline`, atomic quotas, backup drill. Missing: no deploy, no live auth, no pentest, no certification.                                        |
| Support  | 0     | None.                                                                                                                                                                                                                                                                                              |

## What changed since 2.7 (sole-trader rubric re-scored)

Under the old sole-trader rubric, the practice work moves only "Accountant access" from 6 to 8, which adds 0.1. **That makes 2.8/10.** The practice rubric scores today's build **3.1/10**. Neither reaches the 5–6 target. The gap is almost entirely real-world: filing recognition, live data connections, customers and support. More code alone won't close it.

## What only real-world steps can move

| Step                                                                                                                                  | Moves                                                 | Approx. gain |
| ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------ |
| HMRC MTD VAT (then ITSA) production credentials and software-list recognition, plus a qualified adviser verifying rates and deadlines | Filing 1→5                                            | +0.6         |
| Xero, Intuit and FreeAgent developer app approvals (real OAuth), and an FCA-authorised AISP partner (e.g. TrueLayer/Yapily as agent)  | Data 2→8                                              | +0.7         |
| A real OCR/LLM provider with a DPA, evaluated on consented real data                                                                  | Capture 1→6, AI 4→6                                   | +0.6         |
| A transactional email provider for portal links, plus AML/KYC and e-sign vendors                                                      | Portal 5→7                                            | +0.2         |
| Deploy with live auth (Cloudflare Access/OIDC), pentest, DPIA                                                                         | Security 3→6                                          | +0.2         |
| 5–10 pilot firms, an accountant design partner, a support rota, published pricing                                                     | Trust 0→2, Support 0→4, Price 3→6, Workflow/Review +1 | +0.6         |

Together these give about **6.1/10**, assuming they all succeed. No code change can substitute for any of them.

## Sources (accessed 25 Oct 2026)

- [P1] Xero: Partner Hub + Practice Management, free for Silver+ partners, else £99/mo for up to 10 users; JAX in beta. https://www.xero.com/uk/xero-practice-manager/ and https://www.xero.com/uk/accountants-bookkeepers/partner-hub/
- [P2] Xero Partner Programme, "250,000 accountants and bookkeepers". https://www.xero.com/uk/partner-programme/
- [P3] Karbon pricing: Team $59, Business $89 per user per month (annual). https://karbonhq.com/pricing/; not HMRC filing software: https://accountingstack.co.uk/accounting-software/reviews/karbon/
- [P4] TaxDome pricing: $800/$1,000/$1,200 per seat per year (US). https://taxdome.com/pricing
- [P5] Dext practice pricing: Solo £2.50 per client per month, Essentials/Advanced per client with a 10-client minimum. https://dext.com/uk/partner/pricing
- [P6] AutoEntry: £15.45 (50 credits) to £518.25 (2,500 credits) per month. https://www.autoentry.com/pricing
- [P7] Intuit Accountant Suite: Core free; QBOA discontinued 31 Dec 2026; Accelerate $149/mo from 20 Jan 2027. https://quickbooks.intuit.com/accountants/pricing/
- [P8] Basis: $100m Series B at $1.15bn valuation (24 Feb 2026). https://www.reuters.com/business/ai-accounting-startup-basis-raises-100-million-115-billion-valuation-2026-02-24/
- [P9] IRIS Elements: Accounts Production from £4.33/mo, Practice Management from £13 per user per month. https://www.iris.co.uk/products/iris-elements/
- [P10] Sage for Accountants: free for verified accountants (Copilot, final accounts, tax), client plans £3–£25/mo. https://www.sage.com/en-gb/accountants/pricing/
- Pennylane funding and positioning: see S17/S18 in `competitive-benchmark.md`.
