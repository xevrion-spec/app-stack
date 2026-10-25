/**
 * Minimal Langfuse tracer over the public ingestion API (fetch only: runs in Workers, Node and tests).
 * Privacy default: callers pass summaries (counts, methods, scores), never raw bank descriptions.
 * Failures to export are swallowed: tracing must never break bookkeeping.
 */
export interface TraceHandle {
  readonly id: string;
  span<T>(name: string, input: unknown, fn: () => Promise<T>, summarise?: (out: T) => unknown): Promise<T>;
  event(name: string, metadata?: unknown): void;
  end(output?: unknown, scores?: { name: string; value: number; comment?: string }[]): void;
}
export interface PipelineTracer {
  trace(name: string, input?: unknown, meta?: { sessionId?: string; userId?: string; tags?: string[]; metadata?: unknown }): TraceHandle;
  flush(): Promise<void>;
}

const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

export const noopPipelineTracer: PipelineTracer = {
  trace: () => ({ id: "noop", span: (_n, _i, fn) => fn(), event: () => {}, end: () => {} }),
  flush: async () => {},
};

type Ev = { id: string; timestamp: string; type: string; body: Record<string, unknown> };

/** Records events in memory (tests, local debugging). */
export class MemoryTracer implements PipelineTracer {
  events: Ev[] = [];
  trace(name: string, input?: unknown, meta: Parameters<PipelineTracer["trace"]>[2] = {}): TraceHandle {
    const traceId = uid();
    const push = (type: string, body: Record<string, unknown>) => this.events.push({ id: uid(), timestamp: now(), type, body });
    push("trace-create", { id: traceId, name, input, ...meta });
    return {
      id: traceId,
      span: async (n, i, fn, summarise) => {
        const id = uid();
        push("span-create", { id, traceId, name: n, input: i, startTime: now() });
        try {
          const out = await fn();
          push("span-update", { id, traceId, endTime: now(), output: summarise ? summarise(out) : undefined });
          return out;
        } catch (e) {
          push("span-update", { id, traceId, endTime: now(), level: "ERROR", statusMessage: String(e).slice(0, 500) });
          throw e;
        }
      },
      event: (n, m) => push("event-create", { id: uid(), traceId, name: n, metadata: m }),
      end: (output, scores = []) => {
        push("trace-create", { id: traceId, output });
        for (const s of scores) push("score-create", { id: uid(), traceId, ...s });
      },
    };
  }
  async flush() {}
}

export class LangfuseTracer extends MemoryTracer {
  constructor(
    private host: string,
    private publicKey: string,
    private secretKey: string,
    private fetchImpl: typeof fetch = fetch,
  ) {
    super();
  }
  override async flush() {
    const batch = this.events.splice(0);
    if (!batch.length) return;
    try {
      const auth = btoa(`${this.publicKey}:${this.secretKey}`);
      const r = await this.fetchImpl(this.host.replace(/\/$/, "") + "/api/public/ingestion", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Basic ${auth}` },
        body: JSON.stringify({ batch }),
      });
      if (!r.ok && r.status !== 207) console.warn(`langfuse: ingestion HTTP ${r.status}`);
    } catch (e) {
      console.warn(`langfuse: export failed ${String(e).slice(0, 120)}`);
    }
  }
}

export function tracerFromEnv(
  env: { LANGFUSE_HOST?: string; LANGFUSE_PUBLIC_KEY?: string; LANGFUSE_SECRET_KEY?: string },
  fetchImpl?: typeof fetch,
): PipelineTracer {
  if (!env.LANGFUSE_HOST || !env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) return noopPipelineTracer;
  return new LangfuseTracer(env.LANGFUSE_HOST, env.LANGFUSE_PUBLIC_KEY, env.LANGFUSE_SECRET_KEY, fetchImpl);
}
