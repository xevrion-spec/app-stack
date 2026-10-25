// Using a scoped API key against the LOCAL API (synthetic data). AUTOPILOT_KEY=ap_test_... node examples/api-key-client.mjs
const base = process.env.AUTOPILOT_API ?? "http://127.0.0.1:8787";
const h = { authorization: `Bearer ${process.env.AUTOPILOT_KEY}`, "content-type": "application/json" };
let cursor;
do {
  const r = await fetch(`${base}/v1/transactions?limit=100&sort=-amount_pence&fields=id,description,amount_pence${cursor ? `&cursor=${cursor}` : ""}`, { headers: h });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  console.log("remaining requests this window:", r.headers.get("ratelimit-remaining"));
  const page = await r.json();
  for (const t of page.items) console.log(t.id, t.amount_pence, t.description);
  cursor = page.nextCursor;
} while (cursor);
const auto = await fetch(`${base}/v1/automations/from-template`, { method: "POST", headers: { ...h, "idempotency-key": "example-1" }, body: JSON.stringify({ templateId: "auto-categorise-merchant", params: { merchant: "ADOBE", categoryCode: "6200" } }) });
console.log("automation:", auto.status, await auto.json());
