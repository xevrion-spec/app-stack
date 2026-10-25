/**
 * Minimal, strict OpenAPI 3.1 response validator for contract tests (the subset our generator emits). Strict: an
 * object with declared `properties` and no `additionalProperties` is closed, so an undocumented field fails.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type S = Record<string, unknown>;
export const spec = JSON.parse(readFileSync(fileURLToPath(import.meta.url).replace(/apps[\\/]api[\\/]test[\\/][^\\/]+$/, "openapi/openapi.json"), "utf8")) as {
  paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, { schema: S }> }> }>>;
  components: { schemas: Record<string, S> };
};

const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
const typeOk = (t: string, v: unknown) => t === typeOf(v) || (t === "number" && typeOf(v) === "integer");

export function validate(schema: S, v: unknown, at = "$"): string[] {
  if (schema.$ref) return validate(spec.components.schemas[String(schema.$ref).split("/").pop()!]!, v, at);
  const errs: string[] = [];
  for (const k of ["anyOf", "oneOf"] as const)
    if (Array.isArray(schema[k]) && !(schema[k] as S[]).some((s) => !validate(s, v, at).length)) errs.push(`${at}: matches none of ${k}`);
  if (Array.isArray(schema.allOf)) {
    // Merge object parts so strictness applies to the combined property set (a part alone is not "closed").
    const parts = (schema.allOf as S[]).map((x) => (x.$ref ? spec.components.schemas[String(x.$ref).split("/").pop()!]! : x));
    const merged: S = { type: "object", properties: {}, required: [] };
    for (const x of parts) {
      Object.assign(merged.properties as S, x.properties ?? {});
      (merged.required as string[]).push(...((x.required ?? []) as string[]));
    }
    return [...errs, ...validate(merged, v, at)];
  }
  if (schema.type !== undefined) {
    const ts = ([] as string[]).concat(schema.type as string);
    if (!ts.some((t) => typeOk(t, v))) return [...errs, `${at}: expected ${ts.join("|")}, got ${typeOf(v)}`];
  }
  if (schema.nullable && v === null) return errs;
  if ("const" in schema && v !== schema.const) errs.push(`${at}: expected const ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).includes(v)) errs.push(`${at}: ${JSON.stringify(v)} not in enum`);
  if (typeof v === "string") {
    if (typeof schema.minLength === "number" && v.length < schema.minLength) errs.push(`${at}: shorter than ${schema.minLength}`);
    if (typeof schema.maxLength === "number" && v.length > schema.maxLength) errs.push(`${at}: longer than ${schema.maxLength}`);
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(v)) errs.push(`${at}: does not match ${schema.pattern}`);
  }
  if (typeof v === "number") {
    if (typeof schema.minimum === "number" && v < schema.minimum) errs.push(`${at}: < minimum`);
    if (typeof schema.maximum === "number" && v > schema.maximum) errs.push(`${at}: > maximum`);
  }
  if (Array.isArray(v) && schema.items) v.forEach((x, i) => errs.push(...validate(schema.items as S, x, `${at}[${i}]`)));
  if (typeOf(v) === "object") {
    const o = v as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, S>;
    for (const r of (schema.required ?? []) as string[]) if (!(r in o)) errs.push(`${at}.${r}: required`);
    for (const [k, x] of Object.entries(o)) {
      if (props[k]) errs.push(...validate(props[k], x, `${at}.${k}`));
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object")
        errs.push(...validate(schema.additionalProperties as S, x, `${at}.${k}`));
      else if (schema.properties && schema.additionalProperties === undefined) errs.push(`${at}.${k}: undocumented field`);
      else if (schema.additionalProperties === false) errs.push(`${at}.${k}: not allowed`);
    }
  }
  return errs;
}

/** Find the documented operation for a concrete request and validate status + body. */
export function checkResponse(method: string, url: string, status: number, body: unknown, contentType: string | null): string[] {
  const path = new URL(url, "http://x").pathname;
  const entry = Object.entries(spec.paths).find(([tpl]) => new RegExp(`^${tpl.replace(/\{[^}]+\}/g, "[^/]+")}$`).test(path));
  if (!entry) return [`${method} ${path}: undocumented path`];
  const op = entry[1][method.toLowerCase()];
  if (!op) return [`${method} ${entry[0]}: undocumented method`];
  const res = op.responses[String(status)];
  if (!res) return [`${method} ${entry[0]}: undocumented status ${status}`];
  const media = Object.keys(res.content ?? {})[0];
  if (!media) return [];
  if (contentType && !contentType.startsWith(media)) return [`${method} ${entry[0]} ${status}: content-type ${contentType} != ${media}`];
  if (!media.startsWith("application/json")) return [];
  return validate(res.content![media]!.schema, body).map((e) => `${method} ${entry[0]} ${status} ${e}`);
}
