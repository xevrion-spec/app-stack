# Demo script: a synthetic day in the life of a practice

**Every name, amount, document and answer in this demo is synthetic and invented.** No real client data, emails, HMRC calls or bank connections are involved. Tax figures in the app stay config-driven and **unverified**.

## Run it

- **Locally:** `npm run dev` (API on :8787, web on :5173). Demo mode is on outside production builds.
- **Test deployment:** the web build uses `VITE_DEMO=1` and sits behind the existing Cloudflare Access sign-in. It is not public.
- **Automated:** `npx playwright test -c apps/web/playwright.config.ts demo.spec.ts` runs the flow below on desktop and mobile, with axe accessibility checks.

## Click-through (about 5 minutes)

1. **Sign in** with any synthetic email, for example `demo@example.test`, and create a business.
2. Open **Practice** and click **Load synthetic demo day**. The log narrates each step:
   - the practice "Demo Practice (synthetic)" and three clients are created: Bright Bakery, Northside Plumbing and Pixel Studio;
   - **the client sends documents:** five synthetic bank lines are imported for each client;
   - **AI first pass:** rules categorise each line. The client's auto-approve rule (confidence at least 0.95, allowlisted categories) clears the confident lines and samples 20% of them for QA. Anything uncertain stays an exception;
   - **portal:** the client is invited, uploads the requested statement, answers a query and accepts the engagement letter;
   - a bank reconciliation working paper is prepared.
3. **Review queue (exceptions only):** only the lines the AI could not settle are waiting, for example `MYSTERY PAYEE 77` in Uncategorised (9999). Approval stays disabled until you pick a real category. Choose one and click **Approve**. AI never approves on its own judgement: auto-approval only happens under a rule a manager set, and it is QA-sampled.
4. **Sign-off:** open a client and look at Working papers. The preparer cannot sign off their own paper ("someone else must sign it off"). Sign in as a second staff member to sign it off (four-eyes).
5. **Audit trail:** in the client workspace, click **Export audit trail (CSV)**. Every action above appears: the import, the auto-approval with its policy, the portal actions and your approval.

## What is real and what is a mock

- **Real:** the API, the database writes, the rules categoriser, the auto-approve policy and QA sampling, the portal flows, four-eyes sign-off and the audit export.
- **Not in this demo:** LLM categorisation. It needs FreeLLMAPI, which only runs on Henry's PC, so the deployed demo is rules-only. OCR is not used either, because the demo imports CSV only. See `docs/ai-accuracy.md` for measured accuracy.
