import { describe, it, expect, afterEach } from "vitest";
import { makeEnv, client } from "./harness.js";
import { __setAttachmentScanner, scanAttachment } from "../src/services/attachment-scan.js";

const A = "owner-a@example.test",
  R1 = "reviewer-1@example.test";
const bearer = (k: string) => ({ authorization: `Bearer ${k}` });
const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
afterEach(() => __setAttachmentScanner(null));

async function setup() {
  const h = makeEnv();
  const call = client(h.env);
  await call("POST", "/v1/tenants", { user: A, body: { name: "Evidence Co (synthetic)" } });
  await call("POST", "/v1/users", { user: A, body: { email: R1, role: "reviewer" } });
  const pid = (await call("POST", "/v1/review-projects", { user: A, body: { name: "Ops" } })).json.id as string;
  const key = (await call("POST", "/v1/api-keys", { user: A, body: { name: "agent", scopes: ["reviews:write"], projectId: pid } })).json.key as string;
  const r = (await call("POST", "/v1/agent-reviews", { headers: bearer(key), body: { action: "refund.issue", payload: { amount: 5 } } })).json as {
    id: string;
  };
  const up = (body: BodyInit, type: string, name = "evidence.txt", id = r.id) =>
    call("POST", `/v1/agent-reviews/${id}/attachments`, {
      headers: { ...bearer(key), "content-type": type, "x-filename": encodeURIComponent(name) },
      raw: body,
    });
  return { ...h, call, key, r, up };
}

describe("R4 attachments", () => {
  it("clean upload: stored, listed, downloadable as a file with hardened headers", async () => {
    const s = await setup();
    const res = await s.up("order SYN-1 shipped", "text/plain", 'inv"oice/../x.txt');
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      name: "inv_oice_.._x.txt",
      contentType: "text/plain",
      size: 19,
      scan: { status: "clean", engine: "stub-eicar", detail: null },
      downloadable: true,
    });
    const png = await s.up(PNG, "image/png", "shot.png");
    expect(png.json.scan.status).toBe("clean");
    const list = (await s.call("GET", `/v1/agent-reviews/${s.r.id}/attachments`, { user: R1 })).json.items;
    expect(list.map((a: { name: string }) => a.name)).toEqual(["inv_oice_.._x.txt", "shot.png"]);
    const dl = await s.call("GET", `/v1/agent-reviews/${s.r.id}/attachments/${res.json.id}/content`, { user: R1 });
    expect(dl.status).toBe(200);
    expect(dl.text).toBe("order SYN-1 shipped");
    expect(dl.headers.get("content-disposition")).toBe('attachment; filename="inv_oice_.._x.txt"');
    expect(dl.headers.get("x-content-type-options")).toBe("nosniff");
    expect(dl.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect((await s.call("GET", `/v1/agent-reviews/${s.r.id}/attachments/nope/content`, { user: R1 })).status).toBe(404);
  });
  it("blocks malware (stub), spoofed types and executables; none are stored or downloadable; audited", async () => {
    const s = await setup();
    const before = s.objects.size;
    const bad = await s.up(EICAR, "text/plain", "eicar.txt");
    expect(bad.json).toMatchObject({ scan: { status: "infected", engine: "stub-eicar", detail: "EICAR-Test-File" }, downloadable: false });
    expect((await s.call("GET", `/v1/agent-reviews/${s.r.id}/attachments/${bad.json.id}/content`, { user: A })).json.error.code).toBe("attachment_blocked");
    expect((await s.up("not a png", "image/png")).json.scan).toEqual({ status: "rejected", engine: "type-check", detail: "content does not match image/png" });
    expect((await s.up(new Uint8Array([0x4d, 0x5a, 0x90, 0]), "application/pdf")).json.scan.detail).toBe("executable content");
    expect((await s.up("{bad", "application/json")).json.scan.detail).toBe("invalid JSON");
    expect((await s.up(new Uint8Array([0xff, 0xfe, 0]), "text/csv")).json.scan.status).toBe("rejected");
    expect(s.objects.size).toBe(before);
    const audit = s.raw.prepare("select action from audit_log where action like 'review.attachment_%' order by created_at").all() as { action: string }[];
    expect(audit.map((x) => x.action)).toEqual([
      "review.attachment_infected",
      "review.attachment_rejected",
      "review.attachment_rejected",
      "review.attachment_rejected",
      "review.attachment_rejected",
    ]);
  });
  it("limits: type allowlist, size, empty, per-request cap, open requests only, scoped access", async () => {
    const s = await setup();
    expect((await s.up("<b>x</b>", "text/html")).status).toBe(415);
    expect((await s.up("x", "")).status).toBe(415);
    expect((await s.up("", "text/plain")).status).toBe(400);
    expect((await s.up(new Uint8Array(10 * 1024 * 1024 + 1).fill(65), "text/plain")).status).toBe(413);
    for (let i = 0; i < 20; i++) expect((await s.up(`f${i}`, "text/plain")).status).toBe(201);
    expect((await s.up("one more", "text/plain")).status).toBe(409);
    await s.call("POST", `/v1/agent-reviews/${s.r.id}/decisions`, { user: R1, body: { decision: "approve" } });
    const s2 = await setup();
    await s2.call("POST", `/v1/agent-reviews/${s2.r.id}/decisions`, { user: R1, body: { decision: "reject", reason: "no" } });
    expect((await s2.up("late", "text/plain")).status).toBe(409);
    expect((await s2.up("x", "text/plain", "a", "nope")).status).toBe(404);
  });
  it("redaction wipes attachment names and bytes", async () => {
    const s = await setup();
    const a = (await s.up("secret evidence", "text/plain", "customer.txt")).json;
    await s.call("POST", `/v1/agent-reviews/${s.r.id}/decisions`, { user: R1, body: { decision: "reject", reason: "no" } });
    const keysBefore = [...s.objects.keys()].filter((k) => k.includes("review-attachments")).length;
    expect(keysBefore).toBe(1);
    expect((await s.call("POST", `/v1/agent-reviews/${s.r.id}/redact`, { user: A })).status).toBe(200);
    expect([...s.objects.keys()].filter((k) => k.includes("review-attachments"))).toEqual([]);
    const list = (await s.call("GET", `/v1/agent-reviews/${s.r.id}/attachments`, { user: A })).json.items;
    expect(list[0]).toMatchObject({ id: a.id, name: "[redacted]", downloadable: false });
    expect((await s.call("GET", `/v1/agent-reviews/${s.r.id}/attachments/${a.id}/content`, { user: A })).status).toBe(404);
  });
  it("pluggable engine; engine failure fails closed", async () => {
    __setAttachmentScanner({ name: "test-engine", scan: async (b) => ({ infected: b[0] === 0x21 }) });
    expect(await scanAttachment(new TextEncoder().encode("!bad"), "text/plain")).toEqual({ status: "infected", engine: "test-engine", detail: "malware" });
    expect((await scanAttachment(new TextEncoder().encode("ok"), "text/plain")).status).toBe("clean");
    __setAttachmentScanner({ name: "broken", scan: async () => Promise.reject(new Error("down")) });
    expect(await scanAttachment(new TextEncoder().encode("ok"), "text/plain")).toEqual({
      status: "rejected",
      engine: "broken",
      detail: "scanner error (fail closed)",
    });
    __setAttachmentScanner(null);
    for (const [bytes, type] of [
      [[0x25, 0x50, 0x44, 0x46, 0x2d, 0x31], "application/pdf"],
      [[0xff, 0xd8, 0xff, 0xe0], "image/jpeg"],
      [[0x47, 0x49, 0x46, 0x38, 0x39, 0x61], "image/gif"],
      [[0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50], "image/webp"],
    ] as const)
      expect((await scanAttachment(new Uint8Array(bytes), type)).status).toBe("clean");
    expect((await scanAttachment(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x41, 0x56, 0x49, 0x20]), "image/webp")).status).toBe("rejected");
    for (const exe of [
      [0x7f, 0x45, 0x4c, 0x46],
      [0xcf, 0xfa, 0xed, 0xfe],
      [0xfe, 0xed, 0xfa, 0xcf],
      [0x23, 0x21, 0x2f],
    ])
      expect((await scanAttachment(new Uint8Array(exe), "text/plain")).detail).toBe("executable content");
    expect((await scanAttachment(new TextEncoder().encode(`${"a".repeat(5000)}${EICAR}`), "text/plain")).status).toBe("clean");
  });
});
