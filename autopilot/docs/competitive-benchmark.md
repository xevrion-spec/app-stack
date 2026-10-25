# Competitive benchmark — Autopilot vs the UK sole-trader back-office market

_Researched 25 Oct 2026, from public vendor pages and reputable third parties (sources and dates below). Prices are in
GBP excluding VAT unless stated. Scores are my judgement, made against the evidence listed, on a 0–10 scale._

## How Autopilot is scored

**Autopilot is scored as it exists TODAY**, at feature/harden c786663. Under the rules for this benchmark:

- mocks count as missing;
- unverified tax rules, no HMRC recognition and no real bank feeds are penalised heavily;
- there are no customers, no live deployment and no support function.

A second row scores the **realistic 6–12 month potential**. It assumes:

- HMRC MTD recognition for VAT and ITSA has been obtained, with the tax rules reviewed by a qualified adviser;
- real Open Banking runs through an FCA-authorised AISP partner, such as TrueLayer or Yapily as agent;
- real OCR;
- a paid beta of a few hundred users.

## Scorecard

### Weights and what each metric means

The weights reflect what a UK sole trader actually needs to stay compliant and spend less time on admin.

| Metric                           | Weight | What earns a 10                                                                     |
| -------------------------------- | ------ | ----------------------------------------------------------------------------------- |
| MTD VAT + ITSA (HMRC-recognised) | 15     | Listed in HMRC's software finder; files quarterly updates and the final declaration |
| Price / value                    | 10     |                                                                                     |
| Bank feeds                       | 10     | Live Open Banking via an FCA-authorised route                                       |
| AI automation depth              | 10     |                                                                                     |
| Receipt capture                  | 7      |                                                                                     |
| Whole job done for you           | 7      | Humans or agents do the books and file                                              |
| Customers / trust / funding      | 7      |                                                                                     |
| Invoicing                        | 6      |                                                                                     |
| API / integrations               | 6      |                                                                                     |
| Reports                          | 5      |                                                                                     |
| Accountant access                | 5      |                                                                                     |
| Payroll                          | 4      |                                                                                     |
| Regulatory compliance & security | 4      |                                                                                     |
| UX                               | 2      |                                                                                     |
| Support                          | 2      |                                                                                     |

The weights total 100%.

### Scores

| Product           | Price (10) | MTD (15) | Bank (10) | Receipts (7) | Invoice (6) | Payroll (4) | Reports (5) | Accountant (5) | API (6) | AI (10) | Done-for-you (7) | Trust (7) | Compliance (4) | UX (2) | Support (2) | **/10** |
| ----------------- | ---------- | -------- | --------- | ------------ | ----------- | ----------- | ----------- | -------------- | ------- | ------- | ---------------- | --------- | -------------- | ------ | ----------- | ------- |
| QuickBooks        | 8          | 9        | 9         | 8            | 8           | 6           | 8           | 9              | 9       | 6       | 2                | 10        | 9              | 8      | 6           | **7.8** |
| Xero              | 6          | 9        | 9         | 8            | 9           | 7           | 9           | 10             | 10      | 5       | 2                | 10        | 9              | 8      | 6           | **7.8** |
| FreeAgent         | 8          | 10       | 8         | 6            | 8           | 7           | 7           | 9              | 6       | 4       | 3                | 9         | 9              | 8      | 9           | **7.4** |
| Sage              | 9          | 9        | 8         | 6            | 7           | 7           | 7           | 9              | 7       | 4       | 2                | 9         | 9              | 6      | 6           | **7.2** |
| Crunch            | 8          | 9        | 8         | 6            | 7           | 6           | 6           | 8              | 4       | 3       | 7                | 7         | 8              | 6      | 8           | **6.8** |
| Autopilot 6-12 mo | 8          | 7        | 7         | 6            | 6           | 0           | 6           | 7              | 7       | 8       | 7                | 2         | 6              | 7      | 4           | **6.3** |
| Coconut           | 7          | 9        | 8         | 6            | 6           | 0           | 5           | 6              | 2       | 5       | 3                | 6         | 7              | 8      | 7           | **6.0** |
| Countingup        | 7          | 6        | 9         | 7            | 6           | 0           | 5           | 5              | 2       | 5       | 4                | 6         | 9              | 8      | 6           | **5.8** |
| Pennylane (FR)    | 5          | 0        | 7         | 8            | 8           | 3           | 8           | 10             | 8       | 7       | 4                | 8         | 6              | 8      | 6           | **5.8** |
| Pandle            | 10         | 9        | 6         | 5            | 6           | 0           | 6           | 7              | 3       | 3       | 1                | 5         | 7              | 6      | 5           | **5.7** |
| FreshBooks        | 5          | 5        | 7         | 6            | 9           | 2           | 6           | 6              | 7       | 3       | 2                | 7         | 7              | 8      | 7           | **5.5** |
| Digits (US)       | 5          | 0        | 8         | 6            | 7           | 0           | 8           | 7              | 7       | 8       | 5                | 6         | 5              | 8      | 5           | **5.3** |
| Pilot (US)        | 3          | 0        | 8         | 6            | 4           | 2           | 8           | 8              | 5       | 6       | 9                | 8         | 6              | 7      | 8           | **5.3** |
| Zeni (US)         | 2          | 0        | 8         | 6            | 5           | 2           | 8           | 7              | 5       | 7       | 9                | 6         | 5              | 7      | 7           | **5.1** |
| Dext (add-on)     | 5          | 0        | 3         | 10           | 0           | 0           | 2           | 9              | 8       | 7       | 3                | 8         | 7              | 8      | 6           | **4.6** |
| Bench (US)        | 3          | 0        | 7         | 5            | 2           | 0           | 7           | 6              | 3       | 4       | 8                | 5         | 5              | 7      | 6           | **4.1** |
| Autopilot TODAY   | 3          | 1        | 2         | 2            | 5           | 0           | 5           | 6              | 6       | 4       | 2                | 0         | 2              | 5      | 0           | **2.7** |

Notes on the table:

- US and FR products score 0 on MTD because they do not serve UK MTD. That is fair for a UK sole trader, but it
  understates them as products.
- Basis, Rillet and Vic.ai target accounting firms or mid-market finance teams. They are listed in "AI-native landscape"
  for context and are not scored against a sole-trader need.
- Bokio has withdrawn from the UK (its UK app shows a closure notice) [S14].
- Puzzle and Fyle were not researched in depth in this pass, so they are not scored. No numbers were invented for them.

## One-line rationale per score

### Autopilot today (2.7)

| Metric                | Score | Rationale                                                                                                                                                             |
| --------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Price                 | 3     | Nothing is purchasable yet. The cost model exists, but there is no public price.                                                                                      |
| MTD                   | 1     | It calculates VAT boxes, ITSA estimates and deadlines, but it cannot submit, is not HMRC-recognised and its rates are unverified.                                     |
| Bank                  | 2     | Robust, fuzz-tested CSV/OFX/QIF/MT940 import, but the "feeds" are a mock.                                                                                             |
| Receipts              | 2     | Upload, sha256 de-dupe and the review queue are real; OCR is a mock.                                                                                                  |
| Invoicing             | 5     | Real invoices, PDF, credit notes, ETag edits and aged debtors. No live payment collection and no sending, since sends are disabled.                                             |
| Payroll               | 0     | Not built.                                                                                                                                                            |
| Reports               | 5     | Double-entry ledger, P&L and exports. Few report types, and no accountant-grade year-end pack.                                                                        |
| Accountant access     | 6     | Owner/accountant/reviewer roles, tested by a 159-case authz matrix. No practice dashboard.                                                                            |
| API                   | 6     | OpenAPI with 109 paths, scoped API keys, signed webhooks and an SDK. That is a better public API than most UK SMB tools, but there are zero third-party integrations. |
| AI                    | 4     | Deterministic rules engine, categorisation, an assistant over the ledger and an exception queue. Mostly heuristic, with no production LLM loop.                       |
| Done-for-you          | 2     | "Autopilot" is the promise, but nothing is filed or reconciled end-to-end against real data.                                                                          |
| Trust                 | 0     | No customers, no funding, no reviews.                                                                                                                                 |
| Compliance & security | 2     | Strong engineering (authz matrix, fuzzing, ASVS checklist), but no HMRC recognition, no FCA route, no pentest and no live auth.                                       |
| UX                    | 5     | Lighthouse: performance 100, accessibility 100; axe-clean. No user testing.                                                                                           |
| Support               | 0     | None.                                                                                                                                                                 |

### Autopilot in 6–12 months (6.3)

This assumes HMRC recognition and an AISP partner. It would then rank around **6th of 17**, just under Crunch and above
Coconut, Countingup and Pandle. Payroll stays at 0 by design (sole traders rarely need it), and trust stays low because
a brand cannot be bought within a year.

### Competitors

| Product    | Rationale                                                                                                                                                                                                 |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Xero       | 1.3m UK customers (Aug 2026) [S5]. HMRC-recognised, with the deepest app ecosystem. Hubdoc is included [S2]. The price rose on 1 Sep 2026 to Ignite £18 / Grow £39 [S1]. AI is assistive, not autonomous. |
| QuickBooks | Sole Trader Plus is £10 for MTD ITSA, but VAT needs Simple Start at £16 [S3]. HMRC-recognised [S4]. AI categorisation on all plans.                                                                       |
| FreeAgent  | £19/mo, and free with NatWest/RBS/Ulster/Mettle accounts [S6]. End-to-end MTD ITSA (quarterly + final declaration), payroll, UK support accountants. Smart Capture costs +£5 [S6].                        |
| Sage       | Sole Trader Free (5 invoices, 25 auto-categorised transactions) and £7 paid; Accounting from £20 for VAT [S7].                                                                                            |
| Crunch     | Free with ads; Plus at £10 files MTD VAT + ITSA; accountant bundles from £27 [S8][S9]. The closest existing "done for you" UK model.                                                                      |
| Coconut    | £129.99/yr MTD filing plan, HMRC-recognised and in the finder since 25 Jul 2025 [S10][S11]. Simple, sole-trader-first.                                                                                    |
| Countingup | A bank (Griffin, FSCS) plus books; £5/£12/£20 by deposits [S12][S13]. MTD ITSA recognition not confirmed in my sources.                                                                                   |
| Pandle     | Free plan includes MTD ITSA submissions; Pro is £5 [S15]. The price floor for the market.                                                                                                                 |
| FreshBooks | £16/£30/£42 [S16]. Invoicing-first; MTD VAT recognised. ITSA not confirmed.                                                                                                                               |
| Pennylane  | €2bn → $4.25bn valuation; €175m round in Jan 2026 [S17][S18]. France-first; the clearest proof that "accounting OS + accountant collaboration" wins.                                                      |
| Dext       | Business plan about £24/mo (£290/yr) [S19]. Best-in-class capture, but it is an add-on, not a ledger.                                                                                                     |
| Digits     | "Autonomous General Ledger", about $100m raised, $65–$250/mo, US only [S20][S21].                                                                                                                         |
| Pilot      | Bookkeeping from $99/mo (Essentials), human + software [S22]. US only.                                                                                                                                    |
| Zeni       | Managed AI bookkeeping from $549/mo [S23]. US startups.                                                                                                                                                   |
| Bench      | Shut down in Dec 2024, then acquired by Employer.com; plans from $199/mo [S24]. A cautionary tale on done-for-you unit economics.                                                                         |

## AI-native landscape (context, not scored)

| Company | Funding                                                  | Note                                 |
| ------- | -------------------------------------------------------- | ------------------------------------ |
| Basis   | $100m Series B at a $1.15bn valuation, 24 Feb 2026 [S25] | AI agents for accounting _firms_     |
| Rillet  | $70m Series B, Aug 2025, about $500m valuation [S26]     | AI-native ERP/GL for mid-market SaaS |

Neither targets UK sole traders. Both show that investors pay for _autonomy_ (work done) rather than for software seats.

## Brutally honest findings

1. **Today Autopilot is a well-engineered prototype, not a product: 2.7/10, last of 17.**
   - Every UK incumbent is HMRC-recognised, has live bank feeds and has 100k–1.3m customers.
   - Autopilot cannot file anything, cannot pull a single real transaction automatically, and its tax figures are
     explicitly unverified.
2. **Compliance is the moat you do not have yet, and it carries the most weight.**
   - HMRC recognition (MTD VAT + ITSA) and an FCA-authorised AISP route together account for 25% of the score.
   - Without them, no amount of AI or code quality matters to a sole trader.
3. **Price is not a wedge.**
   - Pandle files MTD ITSA for free. FreeAgent is free with NatWest/Mettle. QuickBooks is £10 and Sage £7.
   - You cannot undercut zero. You have to sell _time saved and certainty_, not software.
4. **The genuine differentiators are real but invisible to buyers today:**
   - an exception-first "review queue" model, where AI does the work and the human approves;
   - a public, contract-tested API with signed webhooks, scoped keys and idempotency (better than most UK SMB tools);
   - security and quality depth: authz matrix on every endpoint, parser fuzzing, 2,218 tests, 96% coverage, ASVS
     checklist;
   - performance headroom: 100k-transaction tenants list in about 1 ms.
5. **"Whole job done for you" is the empty quadrant in the UK.**
   - Crunch does it with humans (from £27/mo plus quotes).
   - Digits, Zeni and Pilot do it in the US at $65–$800/mo.
   - Nobody in the UK offers a £15–£30/mo _autonomous_ bookkeeper that files MTD ITSA with a human-in-the-loop
     approval. That is the wedge.

## Realistic wedge

**"MTD ITSA on autopilot for £50k+ sole traders newly mandated since April 2026, and £30k+ from April 2027 [S4]."**

The pitch: connect your bank once; Autopilot categorises everything, chases receipts, prepares each quarterly update,
and you approve it in two minutes. An accountant can be added, either your own or a partner.

The sequence:

1. Become HMRC-recognised for MTD ITSA. Use the HMRC sandbox and the recognition process; this is the gating item.
2. Integrate an FCA-authorised AISP as agent, so there is no FCA licence of your own.
3. Real OCR.
4. Get a qualified adviser to sign off the rate tables.
5. A paid beta through accountants: give them a practice view and use the API as the channel.

Price it at £15–£25/mo, on outcomes ("quarterlies filed"), not seats.

What not to do: payroll, inventory, limited-company accounts, or competing with Xero/QuickBooks on breadth.

## Sources

All sources were accessed on 25 Oct 2026. Where the page states its own date, it is given in brackets.

- [S1] Xero UK pricing update (effective 1 Sep 2026) — https://www.xero.com/uk/pricing-plans/updates/
- [S2] Xero UK pricing plans — https://www.xero.com/uk/pricing-plans/
- [S3] Ledgers, "QuickBooks UK prices 2026" (checked 13 Oct 2026) — https://ledgers.work/blog/quickbooks-uk-prices-2026
- [S4] QuickBooks UK MTD software and MTD dates — https://quickbooks.intuit.com/uk/making-tax-digital/software/
- [S5] SME Magazine interview with Kate Hayward, Xero UK (Aug 2026), 1.3m UK customers — https://www.smeweb.com/xero-uk-managing-director-kate-hayward-on-making-tax-digital-late-payment-ai-financial-literacy-and-cashflow-tips-for-small-businesses/ ; Xero H1 FY26 investor deck (1.21m UK subscribers) — https://brandfolder.xero.com/NE531UQB/as/ks8qbt4tj62mb8j6hpq6mz/Investor_Deck_H1_FY26_Xero
- [S6] FreeAgent pricing and competitor comparison (prices as of 3 Jun 2026) — https://www.freeagent.com/pricing/ , https://www.freeagent.com/features/competitors/
- [S7] Sage UK sole trader — https://www.sage.com/en-gb/products/sage-sole-trader/ , https://www.sage.com/en-gb/pricing/
- [S8] Crunch software pricing — https://www.crunch.co.uk/software-pricing ; Crunch MTD — https://www.crunch.co.uk/making-tax-digital-mtd
- [S9] MTD Radar, Crunch (HMRC list as of 17 Oct 2026) — https://mtdradar.co.uk/software/crunch
- [S10] Coconut pricing — https://www.getcoconut.com/pricing
- [S11] Acrenvo, Coconut listing (checked 12 Oct 2026) — https://acrenvo.com/software/coconut
- [S12] Countingup, "Who provides my account?" (Griffin) — https://support.countingup.com/hc/en-gb/articles/36206524527517-Who-provides-my-account
- [S13] Small Business UK, sole-trader bank accounts (Countingup tiers) — https://smallbusiness.co.uk/best-business-bank-accounts-for-sole-traders-2563034/
- [S14] Bokio UK notice — https://app.bokio.co.uk/
- [S15] MTD Radar, Pandle (as of 17 Oct 2026) — https://mtdradar.co.uk/software/pandle
- [S16] FreshBooks UK pricing — https://www.freshbooks.com/en-gb/pricing ; MTD VAT — https://www.freshbooks.com/en-gb/mtd-vat-software
- [S17] CNBC, Pennylane doubles valuation (6 Apr 2025) — https://www.cnbc.com/2025/04/06/pennylane-doubles-valuation-as-alphabet-vc-fund-takes-stake.html
- [S18] Tech.eu, Pennylane raises $200m (20 Jan 2026) — https://tech.eu/2026/01/20/french-accounting-software-platform-pennylane-raises-200m/
- [S19] ReconcileIQ, Dext pricing UK 2026 — https://reconcileiq.com/blog/dext-pricing-uk
- [S20] Digits, Autonomous General Ledger announcement — https://digits.com/blog/agl-announcement/
- [S21] Digits pricing — https://digits.com/pricing/
- [S22] Pilot pricing — https://pilot.com/pricing
- [S23] Zeni pricing — https://www.zeni.ai/pricing/bookkeeping-packages
- [S24] Bench, About (an Employer.com company) — https://www.bench.co/about ; Pilot's Bench FAQ — https://pilot.com/blog/bench-faq
- [S25] Reuters, Basis raises $100m at $1.15bn (24 Feb 2026) — https://www.reuters.com/business/ai-accounting-startup-basis-raises-100-million-115-billion-valuation-2026-02-24/
- [S26] Reuters, Rillet raises $70m (6 Aug 2025) — https://www.reuters.com/technology/ai-accounting-startup-rillet-raises-70-million-andreessen-horowitz-iconiq-led-2025-08-06/
- HMRC, Choose the right software for MTD for Income Tax — https://www.gov.uk/guidance/choose-the-right-software-for-making-tax-digital-for-income-tax

_Limitations:_

- Several figures come from third-party comparison sites (Ledgers, MTD Radar, Acrenvo, ReconcileIQ) rather than vendor
  pages.
- Re-verify prices before quoting them externally.
- Competitor scores are qualitative; customer counts and review-site ratings were not systematically collected for
  every vendor.
