/** Structured JSON logs (picked up by Workers Logs / observability). Never log secrets or document contents. */
const SENSITIVE_KEY = /secret|token|password|authorization|cookie|api_?key|key_hash/i;
/** Defence in depth: masks credential-looking values even if a caller passes them by mistake (e.g. inside an error string). */
function redact(s: string): string {
  return s
    .replace(/\bap_(live|test)_[A-Za-z0-9_-]+/g, "ap_$1_[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[jwt redacted]")
    .replace(/([?&](?:token|key|secret|signature|sig)=)[^&\s"]+/gi, "$1[redacted]");
}
export function log(level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}): void {
  const line = redact(JSON.stringify({ level, msg, time: new Date().toISOString(), ...fields }, (k, v) => (k && SENSITIVE_KEY.test(k) ? "[redacted]" : v)));
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
