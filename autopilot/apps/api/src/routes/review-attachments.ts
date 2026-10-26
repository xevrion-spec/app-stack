/**
 * R4 evidence attachments on review requests. Uploads are raw bodies (Content-Type + X-Filename), at most 10 MB and 20
 * per request, only while the request is open. Every file is type-checked and scanned before storage; only clean files
 * are stored and downloadable. Downloads are always `attachment` with nosniff, never rendered inline.
 */
import { OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../env.js";
import { def, IdParam, validationHook } from "../lib/route.js";
import { AppError, badRequest, notFound, tooLarge, unsupported } from "../lib/errors.js";
import { newId } from "../lib/db.js";
import { auditStmt } from "../lib/audit.js";
import * as R from "@xevrion/agent-review";
import * as S from "../services/agent-review.js";
import { sha256Hex } from "../services/csv.js";
import { ATTACHMENT_TYPES, MAX_ATTACHMENT_BYTES, scanAttachment } from "../services/attachment-scan.js";
import { accessScope, scope } from "./agent-reviews.js";

export const reviewAttachments = new OpenAPIHono<AppEnv>({ defaultHook: validationHook });
const MAX_PER_REQUEST = 20;

const AttachmentOut = z
  .object({
    id: z.string(),
    name: z.string(),
    contentType: z.string(),
    size: z.number().int(),
    sha256: z.string(),
    scan: z.object({
      status: z.enum(["clean", "infected", "rejected"]),
      engine: z.string().openapi({ description: '"stub-eicar" means no real antivirus engine is configured' }),
      detail: z.string().nullable(),
    }),
    downloadable: z.boolean(),
    uploadedBy: z.string(),
    createdAt: z.string(),
  })
  .openapi("ReviewAttachment");
type Row = {
  id: string;
  name: string;
  content_type: string;
  size: number;
  sha256: string;
  r2_key: string | null;
  scan_status: "clean" | "infected" | "rejected";
  scan_engine: string;
  scan_detail: string | null;
  uploaded_by: string;
  created_at: string;
};
const COLS = "id, name, content_type, size, sha256, r2_key, scan_status, scan_engine, scan_detail, uploaded_by, created_at";
const out = (a: Row) => ({
  id: a.id,
  name: a.name,
  contentType: a.content_type,
  size: a.size,
  sha256: a.sha256,
  scan: { status: a.scan_status, engine: a.scan_engine, detail: a.scan_detail },
  downloadable: a.scan_status === "clean" && !!a.r2_key,
  uploadedBy: a.uploaded_by,
  createdAt: a.created_at,
});
const safeName = (n: string | undefined) =>
  (n ? decodeURIComponent(n) : "attachment")
    .replace(/[\u0000-\u001f\u007f"\\/]/g, "_")
    .slice(0, 120)
    .trim() || "attachment";

reviewAttachments.openAPIRegistry.registerPath(
  def({
    method: "post",
    path: "/agent-reviews/{id}/attachments",
    tag: "Agent review",
    summary: `Attach evidence (raw body; Content-Type one of ${[...ATTACHMENT_TYPES].join(", ")}; X-Filename; at most 10 MB, ${MAX_PER_REQUEST} per request). Scanned before storage.`,
    params: IdParam,
    response: AttachmentOut,
    status: 201,
  }),
);
reviewAttachments.post("/agent-reviews/:id/attachments", async (c) => {
  const db = scope(c);
  const r = await S.loadReview(db, c.req.param("id"), await accessScope(c));
  if (R.FINAL.has(r.status) || r.redacted_at) throw new AppError(409, "already_final", "Attachments can only be added while the request is open");
  const ct = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!ATTACHMENT_TYPES.has(ct)) throw unsupported(`Unsupported attachment type ${ct || "(none)"}`);
  const declared = Number(c.req.header("content-length") ?? 0);
  if (declared > MAX_ATTACHMENT_BYTES) throw tooLarge("Attachment larger than 10 MB");
  const buf = new Uint8Array(await c.req.arrayBuffer());
  if (!buf.byteLength) throw badRequest("Empty file");
  if (buf.byteLength > MAX_ATTACHMENT_BYTES) throw tooLarge("Attachment larger than 10 MB");
  const n = await db.first<{ n: number }>("select count(*) as n from review_attachments where tenant_id = ?1 and request_id = ?2", r.id);
  if ((n?.n ?? 0) >= MAX_PER_REQUEST) throw new AppError(409, "conflict", `At most ${MAX_PER_REQUEST} attachments per request`);
  const scan = await scanAttachment(buf, ct);
  const id = newId();
  const sha = await sha256Hex(buf.buffer);
  const key = scan.status === "clean" ? `${db.tenantId}/review-attachments/${r.id}/${id}` : null;
  if (key) await c.env.DOCS.put(key, buf, { httpMetadata: { contentType: ct }, sha256: sha, customMetadata: { tenant: db.tenantId } });
  const who = c.get("principal").email;
  const at = new Date().toISOString();
  await db.batch([
    db.stmt(
      `insert into review_attachments (tenant_id, request_id, ${COLS}) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
      r.id,
      id,
      safeName(c.req.header("x-filename")),
      ct,
      buf.byteLength,
      sha,
      key,
      scan.status,
      scan.engine,
      scan.detail,
      who,
      at,
    ),
    auditStmt(db, who, `review.attachment_${scan.status}`, r.id, { attachmentId: id, sha256: sha, engine: scan.engine, detail: scan.detail }),
  ]);
  const row = await db.first<Row>(`select ${COLS} from review_attachments where tenant_id = ?1 and id = ?2`, id);
  return c.json(out(row!), 201);
});

reviewAttachments.openapi(
  def({
    method: "get",
    path: "/agent-reviews/{id}/attachments",
    tag: "Agent review",
    summary: "Attachments on a request, with scan results",
    params: IdParam,
    response: z.object({ items: z.array(AttachmentOut) }),
  }),
  async (c) => {
    const db = scope(c);
    const r = await S.loadReview(db, c.req.valid("param").id, await accessScope(c));
    const rows = await db.all<Row>(`select ${COLS} from review_attachments where tenant_id = ?1 and request_id = ?2 order by created_at, id`, r.id);
    return c.json({ items: rows.map(out) }, 200);
  },
);

reviewAttachments.openAPIRegistry.registerPath(
  def({
    method: "get",
    path: "/agent-reviews/{id}/attachments/{attachmentId}/content",
    tag: "Agent review",
    summary: "Download a clean attachment (always as a file; 409 attachment_blocked when infected or rejected)",
    params: IdParam.extend({ attachmentId: z.string() }),
    response: z.string(),
    raw: { contentType: "application/octet-stream" },
  }),
);
reviewAttachments.get("/agent-reviews/:id/attachments/:attachmentId/content", async (c) => {
  const db = scope(c);
  const r = await S.loadReview(db, c.req.param("id"), await accessScope(c));
  const a = await db.first<Row>(
    `select ${COLS} from review_attachments where tenant_id = ?1 and request_id = ?2 and id = ?3`,
    r.id,
    c.req.param("attachmentId"),
  );
  if (!a) throw notFound("Attachment");
  if (a.scan_status !== "clean") throw new AppError(409, "attachment_blocked", `Attachment was ${a.scan_status} by ${a.scan_engine}`);
  const obj = a.r2_key ? await c.env.DOCS.get(a.r2_key) : null;
  if (!obj) throw notFound("Attachment content");
  return new Response(await obj.arrayBuffer(), {
    headers: {
      "content-type": a.content_type,
      "content-disposition": `attachment; filename="${a.name}"`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    },
  });
});
