import { createRoute, z } from "@hono/zod-openapi";
import { ErrorSchema } from "../schemas.js";

const errorResponse = (description: string) => ({ description, content: { "application/json": { schema: ErrorSchema } } });
const errs = {
  400: errorResponse("Bad request"),
  401: errorResponse("Unauthenticated"),
  403: errorResponse("Forbidden"),
  404: errorResponse("Not found"),
  409: errorResponse("Conflict"),
} as const;

type JsonBody<B> = B extends z.ZodTypeAny ? { content: { "application/json": { schema: B } }; required: true } : undefined;

/** Compact, fully-typed route builder: JSON in/out + standard error responses + Access security. */
export function def<
  M extends "get" | "post" | "patch" | "put" | "delete",
  P extends string,
  R extends z.ZodTypeAny,
  B extends z.ZodTypeAny | undefined = undefined,
  Q extends z.AnyZodObject | undefined = undefined,
  Pa extends z.AnyZodObject | undefined = undefined,
  St extends 200 | 201 = 200,
>(o: { method: M; path: P; tag: string; summary: string; body?: B; query?: Q; params?: Pa; response: R; status?: St; raw?: { contentType: string } }) {
  const body = (o.body ? { content: { "application/json": { schema: o.body } }, required: true } : undefined) as JsonBody<B>;
  const status = (o.status ?? 200) as St;
  return createRoute({
    method: o.method,
    path: o.path,
    tags: [o.tag],
    summary: o.summary,
    request: { body, query: o.query as Q, params: o.params as Pa },
    security: [{ accessJwt: [] }],
    responses: {
      [status]: { description: "OK", content: { [o.raw?.contentType ?? "application/json"]: { schema: o.response } } },
      ...errs,
    } as { [K in St]: { description: string; content: { "application/json": { schema: R } } } } & typeof errs,
  });
}
export const IdParam = z.object({ id: z.string().min(1).max(64) });

/** Shared zod validation hook: every app/sub-app returns the same typed 400 error envelope. */
export const validationHook = (
  result: { success: boolean; error?: { flatten: () => unknown } },
  c: { json: (b: unknown, s: 400) => Response; get: (k: "requestId") => string },
) => {
  if (!result.success)
    return c.json(
      { error: { code: "validation_failed", message: "Request validation failed", requestId: c.get("requestId"), details: result.error?.flatten() } },
      400,
    );
  return undefined;
};
