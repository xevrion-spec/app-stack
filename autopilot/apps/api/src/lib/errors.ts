export type ErrorCode =
  | "no_membership"
  | "plan_required"
  | "bad_request"
  | "validation_failed"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "payload_too_large"
  | "unsupported_media_type"
  | "rate_limited"
  | "quota_exceeded"
  | "precondition_failed"
  | "version_conflict"
  | "insufficient_scope"
  | "not_implemented"
  | "maintenance"
  | "internal"
  | "already_final"
  | "self_approval"
  | "duplicate_decision"
  | "already_escalated"
  | "not_requester"
  | "not_in_group"
  | "unsafe_policy";

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}
export const badRequest = (m: string, d?: unknown) => new AppError(400, "bad_request", m, d);
export const unauthenticated = (m = "Authentication required") => new AppError(401, "unauthenticated", m);
export const forbidden = (m = "You do not have permission for this action") => new AppError(403, "forbidden", m);
export const notFound = (what = "Resource") => new AppError(404, "not_found", `${what} not found`);
export const conflict = (m: string) => new AppError(409, "conflict", m);
export const tooLarge = (m: string) => new AppError(413, "payload_too_large", m);
export const unsupported = (m: string) => new AppError(415, "unsupported_media_type", m);
