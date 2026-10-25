/**
 * Framework adapters: put a human review in front of any agent tool. All are structural (duck-typed) so they work
 * without importing the frameworks: Vercel AI SDK tools ({ execute }), LangChain/LangGraph tools ({ invoke }),
 * OpenAI function calling (a name → handler map) and MCP tool handlers. The tool only runs when the review is
 * approved, and it runs with the approved (possibly reviewer-edited) arguments.
 */
import { ReviewClient, ReviewNotApproved, type Review, type ReviewInput } from "./agent-review.js";

type Risk = NonNullable<ReviewInput["risk"]>;
export interface GuardOptions<A> {
  /** Review action name, e.g. "email.send". */
  action: string;
  risk?: Risk | ((args: A) => Risk);
  /** Self-reported model confidence (0..1), used by auto-approve policies. */
  confidence?: (args: A) => number | undefined;
  context?: (args: A) => Record<string, unknown> | undefined;
  tags?: string[];
  /** Stable key per logical call (e.g. run id + tool call id) so restarts don't create duplicate reviews. */
  idempotencyKey?: (args: A, callId?: string) => string | undefined;
  timeoutMs?: number;
  /** What the tool returns instead of running when not approved (default: throw ReviewNotApproved). */
  onNotApproved?: (review: Review) => unknown;
  /** Skip review entirely for some calls (e.g. read-only arguments). */
  skip?: (args: A) => boolean;
}

/** Wrap a plain async function. */
export function guard<A extends Record<string, unknown>, R>(client: ReviewClient, fn: (args: A) => Promise<R>, o: GuardOptions<A>) {
  return async (args: A, callId?: string): Promise<R> => {
    if (o.skip?.(args)) return fn(args);
    const key = o.idempotencyKey?.(args, callId);
    const conf = o.confidence?.(args);
    const ctx = o.context?.(args);
    const review = await client.requestAndWait(
      {
        action: o.action,
        payload: args,
        risk: typeof o.risk === "function" ? o.risk(args) : (o.risk ?? "medium"),
        tags: o.tags ?? [],
        ...(conf !== undefined ? { confidence: conf } : {}),
        ...(ctx ? { context: ctx } : {}),
        ...(key ? { idempotencyKey: key } : {}),
      },
      o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {},
    );
    if (review.status !== "approved") {
      if (o.onNotApproved) return o.onNotApproved(review) as R;
      throw new ReviewNotApproved(review);
    }
    return fn(review.payload as A);
  };
}

/** Vercel AI SDK: `tool({ parameters, execute })` → same tool whose execute waits for approval. */
export function withReviewAiSdk<T extends { execute?: (args: never, opts: { toolCallId?: string }) => Promise<unknown> }>(
  client: ReviewClient,
  tool: T,
  o: GuardOptions<Record<string, unknown>>,
): T {
  const exec = tool.execute as unknown as ((args: Record<string, unknown>, opts: { toolCallId?: string }) => Promise<unknown>) | undefined;
  if (!exec) throw new Error("withReviewAiSdk: tool has no execute()");
  return {
    ...tool,
    execute: async (args: Record<string, unknown>, opts: { toolCallId?: string } = {}) => guard(client, (a) => exec(a, opts), o)(args, opts.toolCallId),
  } as T;
}

/** LangChain / LangGraph JS: any object with `invoke(input, config?)`. Returns a proxy with a guarded invoke. */
export function withReviewInvoke<T extends { invoke: (input: never, config?: never) => Promise<unknown> }>(
  client: ReviewClient,
  tool: T,
  o: GuardOptions<Record<string, unknown>>,
): T {
  const inv = tool.invoke.bind(tool) as unknown as (input: Record<string, unknown>, config?: unknown) => Promise<unknown>;
  return new Proxy(tool, {
    get(target, prop, recv) {
      if (prop !== "invoke") return Reflect.get(target, prop, recv) as unknown;
      return (input: Record<string, unknown>, config?: { configurable?: { thread_id?: string }; runId?: string }) =>
        guard(client, (a) => inv(a, config), o)(input, config?.runId ?? config?.configurable?.thread_id);
    },
  });
}

/**
 * OpenAI-style function calling: runs a batch of tool calls, guarding the ones listed in `guarded`. Rejected calls
 * come back as a tool message the model can read ("not approved by a human reviewer"), so the agent can recover.
 */
export async function runToolCalls(
  client: ReviewClient,
  calls: { id: string; function: { name: string; arguments: string } }[],
  handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>>,
  guarded: Record<string, GuardOptions<Record<string, unknown>>>,
): Promise<{ tool_call_id: string; role: "tool"; content: string }[]> {
  return Promise.all(
    calls.map(async (c) => {
      const h = handlers[c.function.name];
      if (!h) return { tool_call_id: c.id, role: "tool" as const, content: JSON.stringify({ error: `unknown tool ${c.function.name}` }) };
      const args = JSON.parse(c.function.arguments || "{}") as Record<string, unknown>;
      const g = guarded[c.function.name];
      const run = g
        ? guard(client, h, { ...g, onNotApproved: (r) => ({ notApproved: true, status: r.status, reviewId: r.id, note: "not approved by a human reviewer" }) })
        : h;
      return { tool_call_id: c.id, role: "tool" as const, content: JSON.stringify(await run(args, c.id)) };
    }),
  );
}

/** MCP server tool handler `(args, extra) => CallToolResult`: a not-approved call returns isError with an explanation. */
export function withReviewMcp<A extends Record<string, unknown>>(
  client: ReviewClient,
  handler: (args: A, extra?: { requestId?: string | number }) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>,
  o: GuardOptions<A>,
) {
  return (args: A, extra?: { requestId?: string | number }) =>
    guard(client, (a: A) => handler(a, extra), {
      ...o,
      onNotApproved: (r) => ({ content: [{ type: "text" as const, text: `Not approved: review ${r.id} ended ${r.status}.` }], isError: true }),
    })(args, extra?.requestId !== undefined ? String(extra.requestId) : undefined);
}
