/**
 * Per-tenant realtime fan-out. One Durable Object instance per tenant (idFromName(tenantId)) holds the live connections:
 * WebSocket (hibernation API) and Server-Sent Events. The dispatcher POSTs /publish after events commit.
 * `Hub` is the transport-independent core so it can be unit-tested without the Workers runtime.
 */
export interface Subscriber {
  id: string;
  filters: string[];
  send: (frame: string) => void;
}

export const sseFrame = (ev: { id: string; type: string; data: unknown }) =>
  `id: ${ev.id}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev.data).replace(/\n/g, "\\n")}\n\n`;

export class Hub {
  private subs = new Map<string, Subscriber>();
  /** Last N events for reconnect replay (Last-Event-ID). */
  private ring: { id: string; type: string; data: unknown }[] = [];
  constructor(private readonly ringSize = 200) {}
  get size() {
    return this.subs.size;
  }
  add(s: Subscriber, lastEventId?: string | null) {
    this.subs.set(s.id, s);
    if (lastEventId) {
      const i = this.ring.findIndex((e) => e.id === lastEventId);
      if (i >= 0) for (const e of this.ring.slice(i + 1)) if (match(e.type, s.filters)) safeSend(this, s, sseFrame(e));
    }
  }
  remove(id: string) {
    this.subs.delete(id);
  }
  publish(events: { id: string; type: string; data: unknown }[]): number {
    let n = 0;
    for (const e of events) {
      this.ring.push(e);
      if (this.ring.length > this.ringSize) this.ring.shift();
      for (const s of [...this.subs.values()]) if (match(e.type, s.filters) && safeSend(this, s, sseFrame(e))) n++;
    }
    return n;
  }
}
const match = (type: string, filters: string[]) =>
  !filters.length || filters.some((f) => f === "*" || f === type || (f.endsWith(".*") && type.startsWith(f.slice(0, -1))));
function safeSend(h: Hub, s: Subscriber, frame: string): boolean {
  try {
    s.send(frame);
    return true;
  } catch {
    h.remove(s.id); // dead connection: drop it, never let one client break fan-out
    return false;
  }
}

export class TenantRealtime implements DurableObject {
  private hub = new Hub();
  constructor(private readonly state: DurableObjectState) {}
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const filters = (url.searchParams.get("types") ?? "").split(",").filter(Boolean);
    if (url.pathname === "/publish" && req.method === "POST") {
      const events = (await req.json()) as { id: string; type: string; data: unknown }[];
      const n = this.hub.publish(events);
      for (const ws of this.state.getWebSockets()) for (const e of events) if (match(e.type, filters)) ws.send(JSON.stringify(e));
      return Response.json({ delivered: n });
    }
    if (req.headers.get("upgrade") === "websocket") {
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    const id = crypto.randomUUID();
    const { readable, writable } = new TransformStream();
    const w = writable.getWriter();
    const enc = new TextEncoder();
    this.hub.add({ id, filters, send: (f) => void w.write(enc.encode(f)) }, req.headers.get("last-event-id"));
    void w.write(enc.encode(": connected\nretry: 3000\n\n"));
    req.signal?.addEventListener("abort", () => this.hub.remove(id));
    return new Response(readable, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" } });
  }
  webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) {
    if (msg === "ping") ws.send("pong");
  }
}
