// Minimal webhook receiver that verifies Autopilot signatures. node examples/verify-webhook.mjs (uses WEBHOOK_SECRET).
import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
const secret = process.env.WEBHOOK_SECRET ?? "";
export function verify(header, rawBody, now = Date.now() / 1000, toleranceSeconds = 300) {
  if (!header) return false;
  const parts = header.split(",").map((p) => p.trim().split("="));
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  if (!Number.isFinite(t) || Math.abs(now - t) > toleranceSeconds) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex"));
  return parts.some(([k, v]) => k === "v1" && v && v.length === expected.length && timingSafeEqual(Buffer.from(v), expected));
}
if (import.meta.url === `file://${process.argv[1]}`) {
  createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const ok = verify(req.headers["autopilot-signature"], body);
      console.log(ok ? "verified" : "REJECTED", req.headers["autopilot-event-type"], req.headers["autopilot-event-id"]);
      res.writeHead(ok ? 200 : 401).end();
    });
  }).listen(4242, () => console.log("listening on :4242"));
}
