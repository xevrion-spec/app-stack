/**
 * Demo mode: seeds a SYNTHETIC "day in the life of a practice" through the public API only (so it works locally and on
 * the Access-protected test deployment). Every name, amount and document is invented and labelled "(synthetic)".
 * Shown only when VITE_DEMO=1 or outside production.
 */
import { apiBase, devUser, isProd, json } from "./api";

export const demoEnabled = import.meta.env.VITE_DEMO === "1" || !isProd;
const CLIENTS: { name: string; csv: string[] }[] = [
  {
    name: "Bright Bakery (synthetic)",
    csv: [
      "2026-09-01,SUMUP PAYOUT,412.50",
      "2026-09-02,BOOKER WHOLESALE,-186.20",
      "2026-09-03,VODAFONE LTD,-28.00",
      "2026-09-04,HOWDENS JOINERY,-420.00",
      "2026-09-05,TRANSFER TO J BLOGGS,-500.00",
    ],
  },
  {
    name: "Northside Plumbing (synthetic)",
    csv: [
      "2026-09-01,TOOLSTATION,-64.99",
      "2026-09-02,SHELL FUEL,-58.10",
      "2026-09-03,FASTER PAYMENT REF INV 104,480.00",
      "2026-09-04,CITY PLUMBING SUPPLIES,-96.50",
      "2026-09-06,MYSTERY PAYEE 77,-42.00",
    ],
  },
  {
    name: "Pixel Studio (synthetic)",
    csv: [
      "2026-09-01,STRIPE PAYOUT,1250.00",
      "2026-09-02,ADOBE CREATIVE CLOUD,-56.98",
      "2026-09-03,GITHUB INC,-3.70",
      "2026-09-04,CALENDLY SUBSCRIPTION,-9.60",
      "2026-09-05,PINTEREST ADVERTISING,-50.00",
    ],
  },
];
type Log = (line: string) => void;

async function portal<T>(path: string, token: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  headers.set("idempotency-key", crypto.randomUUID());
  const r = await fetch(apiBase + path, { ...init, headers });
  if (!r.ok) throw new Error(`portal ${path}: ${r.status}`);
  return (await r.json()) as T;
}
async function rawPost(path: string, body: string, contentType: string) {
  const headers = new Headers({ "content-type": contentType, "idempotency-key": crypto.randomUUID() });
  const u = devUser.get();
  if (u) headers.set("x-dev-user", u);
  const r = await fetch(apiBase + path, { method: "POST", body, headers, credentials: "include" });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

/** The client side of the day, done through the portal exactly as a client would. */
type QItem = { categoryCode: string | null; confidence: number | null };

/** Wait for the async AI first pass, then let the client's auto-approve rule clear the confident items. */
async function firstPass(tenantId: string, name: string, expected: number, log: Log) {
  let items: QItem[] = [];
  for (let i = 0; i < 40; i++) {
    items = (await json<{ items: QItem[] }>(`/v1/practice/review-queue?clientId=${tenantId}`)).items;
    if (items.length >= expected && items.every((x) => x.categoryCode)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const codes = [...new Set(items.filter((x) => x.categoryCode && x.categoryCode !== "9999").map((x) => x.categoryCode!))].slice(0, 50);
  await json(`/v1/practice/clients/${tenantId}`, "PATCH", { autoApprove: { threshold: 0.95, categories: codes }, qaSampleRate: 0.2 });
  const r = await json<{ approved: number; sampledForQa: number; considered: number }>(`/v1/practice/clients/${tenantId}/auto-approve`, "POST", {
    dryRun: false,
    seed: "demo",
  });
  log(
    `${name}: AI first pass auto-approved ${r.approved} of ${r.considered} lines by the client's rule (confidence at least 0.95; ${r.sampledForQa} sampled for QA); ${r.considered - r.approved} exceptions left for you`,
  );
}

async function clientActs(tenantId: string, name: string, log: Log) {
  const invite = await json<{ magicToken: string }>(`/v1/practice/clients/${tenantId}/portal-users`, "POST", {
    email: `owner@${name.split(" ")[0]!.toLowerCase()}.example.test`,
  });
  const { sessionToken } = await portal<{ sessionToken: string }>("/v1/portal/session", "", {
    method: "POST",
    body: JSON.stringify({ token: invite.magicToken }),
    headers: { "content-type": "application/json" },
  });
  const reqs = await portal<{ items: { id: string; title: string }[] }>("/v1/portal/document-requests", sessionToken);
  const first = reqs.items[0];
  if (first) {
    const doc = `date,description,amount\n2026-09-30,SYNTHETIC STATEMENT LINE,-1.00\n`;
    await portal(`/v1/portal/document-requests/${first.id}/upload`, sessionToken, { method: "POST", body: doc, headers: { "content-type": "text/csv" } });
    log(`${name}: client uploaded "${first.title}" through the portal`);
  }
  const qs = await portal<{ items: { id: string }[] }>("/v1/portal/queries", sessionToken);
  for (const q of qs.items)
    await portal(`/v1/portal/queries/${q.id}/answer`, sessionToken, {
      method: "POST",
      body: JSON.stringify({ answer: "Synthetic answer: a one-off business purchase." }),
      headers: { "content-type": "application/json" },
    });
  const letters = await portal<{ items: { id: string; letterSha256: string }[] }>("/v1/portal/engagements", sessionToken);
  for (const l of letters.items)
    await portal(`/v1/portal/engagements/${l.id}/accept`, sessionToken, {
      method: "POST",
      body: JSON.stringify({ letterSha256: l.letterSha256 }),
      headers: { "content-type": "application/json" },
    });
  await portal("/v1/portal/logout", sessionToken, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
  log(`${name}: client answered ${qs.items.length} query and accepted ${letters.items.length} letter`);
}

export async function seedDemoDay(log: Log): Promise<void> {
  const firm = await json<{ name: string }>("/v1/practice").catch(() => null);
  if (!firm) {
    await json("/v1/practices", "POST", { name: "Demo Practice (synthetic)" });
    log("Created Demo Practice (synthetic)");
  }
  for (const c of CLIENTS) {
    const { tenantId } = await json<{ tenantId: string }>("/v1/practice/clients", "POST", { name: c.name });
    const r = (await rawPost(`/v1/practice/clients/${tenantId}/imports/bank-csv`, `date,description,amount\n${c.csv.join("\n")}\n`, "text/csv")) as {
      inserted?: number;
    };
    log(`${c.name}: imported ${r.inserted ?? c.csv.length} synthetic bank lines; the AI first pass is running`);
    await firstPass(tenantId, c.name, c.csv.length, log);
    const letter = "Synthetic engagement letter: bookkeeping and quarterly VAT returns. Demo data only, not a real agreement.";
    const e = await json<{ id: string }>(`/v1/practice/clients/${tenantId}/engagements`, "POST", {
      services: ["bookkeeping", "vat_returns"],
      feeSummary: "£95 per month (synthetic)",
      letterText: letter,
    });
    await json(`/v1/practice/engagements/${e.id}/send`, "POST");
    await json(`/v1/practice/clients/${tenantId}/document-requests`, "POST", { titles: ["September bank statement (synthetic)"] });
    await json(`/v1/practice/clients/${tenantId}/queries`, "POST", { question: "What was the largest unexplained payment for? (synthetic)" });
    await clientActs(tenantId, c.name, log);
    await json(`/v1/practice/clients/${tenantId}/working-papers`, "POST", { kind: "bank_reconciliation", periodEnd: "2026-09-30" });
    log(`${c.name}: bank reconciliation working paper prepared (awaiting a second person's sign-off)`);
  }
  log("Done. Open the review queue: only the exceptions are waiting for you.");
}
