/**
 * R2 live inbox: a tenant-wide change feed of review requests (no payloads), as a JSON page for polling clients and as
 * server-sent events with Last-Event-ID resume. Visibility follows the same project scope as the request list.
 */
import { OpenAPIHono, z } from "@hono/zod-openapi";
import * as R from "@xevrion/agent-review";
import type { AppEnv } from "../env.js";
import { def, validationHook } from "../lib/route.js";
import { accessScope, pollInterval, scope } from "./agent-reviews.js";
import { bus, feedPage, headCursor, tenantKey } from "../services/review-feed.js";

const LATE_WINDOW_MS = 2000;
export const reviewFeed = new OpenAPIHono<AppEnv>({ defaultHook: validationHook });

const FeedItem = z
  .object({
    id: z.string(),
    projectId: z.string(),
    action: z.string(),
    risk: z.string(),
    status: z.string(),
    version: z.number().int(),
    updatedAt: z.string(),
    cursor: z.string().openapi({ description: "Opaque; pass as `cursor` (or Last-Event-ID) to resume after this change" }),
  })
  .openapi("ReviewFeedItem");

reviewFeed.openapi(
  def({
    method: "get",
    path: "/agent-review/events",
    tag: "Agent review",
    summary: "Change feed of review requests visible to the caller, oldest first after `cursor` (omit it to get the head cursor only). No payloads.",
    query: z.object({ cursor: z.string().max(300).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }),
    response: z.object({ items: z.array(FeedItem), cursor: z.string().nullable() }),
  }),
  async (c) => {
    const db = scope(c);
    const q = c.req.valid("query");
    if (!q.cursor) return c.json({ items: [], cursor: await headCursor(db) }, 200);
    const items = await feedPage(db, await accessScope(c), q.cursor, q.limit);
    return c.json({ items, cursor: items.at(-1)?.cursor ?? q.cursor }, 200);
  },
);

reviewFeed.openAPIRegistry.registerPath(
  def({
    method: "get",
    path: "/agent-review/events/stream",
    tag: "Agent review",
    summary:
      "Server-sent events: `change` per request change (id = resume cursor; honours Last-Event-ID or `cursor`), then `end` after maxSeconds (1..55, default 55). Reconnect to continue.",
    query: z.object({ cursor: z.string().max(300).optional(), maxSeconds: z.coerce.number().int().min(1).max(55).optional() }),
    response: z.string(),
    raw: { contentType: "text/event-stream" },
  }),
);
reviewFeed.get("/agent-review/events/stream", async (c) => {
  const db = scope(c);
  const vis = await accessScope(c);
  const maxSeconds = Math.min(Math.max(Number(c.req.query("maxSeconds") ?? 55) || 55, 1), 55);
  let cursor = c.req.header("last-event-id") || c.req.query("cursor") || (await headCursor(db)) || "";
  const key = tenantKey(db.tenantId);
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(ctl) {
      const write = (s: string) => ctl.enqueue(enc.encode(s));
      write("retry: 2000\n\n");
      const until = Date.now() + maxSeconds * 1000;
      // Writers stamp updated_at before commit, so a slower commit can land "behind" the cursor. Rescan a short window
      // and dedupe by (id, version) so such late commits are still delivered exactly once per stream.
      const seen = new Map<string, number>();
      const scanFrom = () => {
        const d = R.decodeCursor(cursor);
        if (!d) return cursor;
        const t = Date.parse(d.updatedAt);
        return Number.isNaN(t) ? cursor : R.encodeCursor(new Date(t - LATE_WINDOW_MS).toISOString(), "");
      };
      if (cursor) for (const it of await feedPage(db, vis, scanFrom(), 500)) if (R.compareCursors(it.cursor, cursor) <= 0) seen.set(it.id, it.version);
      try {
        while (Date.now() < until) {
          const items = cursor ? (await feedPage(db, vis, scanFrom(), 500)).filter((it) => (seen.get(it.id) ?? -1) < it.version) : [];
          for (const it of items) {
            seen.set(it.id, it.version);
            write(`id: ${it.cursor}\nevent: change\ndata: ${JSON.stringify(it)}\n\n`);
            if (R.compareCursors(it.cursor, cursor) > 0) cursor = it.cursor;
          }
          if (!cursor) cursor = (await headCursor(db)) ?? "";
          await bus.wait(key, Math.min(pollInterval(), Math.max(0, until - Date.now())));
        }
        write(`event: end\ndata: ${JSON.stringify({ reason: "timeout", cursor })}\n\n`);
      } finally {
        ctl.close();
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" } });
});
