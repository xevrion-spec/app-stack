import { z } from "zod";

/**
 * A safe JSON Schema subset for action templates (R4). Interpreted, never compiled (Workers forbid eval), and bounded
 * (depth 8, 64 properties per object), so a template cannot be used to burn CPU.
 * Keywords: type, properties, required, additionalProperties (boolean), items, enum, const, minimum, maximum,
 * minLength, maxLength, pattern, minItems, maxItems, format (email | uri | date | date-time), description, title.
 */
const TYPES = ["object", "array", "string", "number", "integer", "boolean", "null"] as const;
export type SchemaLite = {
  type?: (typeof TYPES)[number];
  properties?: Record<string, SchemaLite>;
  required?: string[];
  additionalProperties?: boolean;
  items?: SchemaLite;
  enum?: (string | number | boolean | null)[];
  const?: string | number | boolean | null;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minItems?: number;
  maxItems?: number;
  format?: "email" | "uri" | "date" | "date-time";
  description?: string;
  title?: string;
};
const scalar = z.union([z.string().max(200), z.number(), z.boolean(), z.null()]);
export const SchemaLite: z.ZodType<SchemaLite> = z.lazy(() =>
  z
    .object({
      type: z.enum(TYPES).optional(),
      properties: z.record(z.string().max(64), SchemaLite).optional(),
      required: z.array(z.string().max(64)).max(64).optional(),
      additionalProperties: z.boolean().optional(),
      items: SchemaLite.optional(),
      enum: z.array(scalar).min(1).max(100).optional(),
      const: scalar.optional(),
      minimum: z.number().optional(),
      maximum: z.number().optional(),
      minLength: z.number().int().min(0).optional(),
      maxLength: z.number().int().min(0).optional(),
      pattern: z.string().max(200).refine(safeRegex, "pattern must be a valid regular expression without backreferences or nested quantifiers").optional(),
      minItems: z.number().int().min(0).optional(),
      maxItems: z.number().int().min(0).optional(),
      format: z.enum(["email", "uri", "date", "date-time"]).optional(),
      description: z.string().max(500).optional(),
      title: z.string().max(120).optional(),
    })
    .strict()
    .refine((s) => !s.properties || Object.keys(s.properties).length <= 64, "at most 64 properties"),
);

/** Rejects patterns prone to catastrophic backtracking (nested quantifiers, backreferences) and invalid ones. */
function safeRegex(p: string): boolean {
  if (/\\\d/.test(p) || /\([^)]*[+*}][^)]*\)[+*{]/.test(p)) return false;
  try {
    new RegExp(p, "u");
    return true;
  } catch {
    return false;
  }
}

export function schemaDepth(s: SchemaLite): number {
  const kids = [...Object.values(s.properties ?? {}), ...(s.items ? [s.items] : [])];
  return 1 + (kids.length ? Math.max(...kids.map(schemaDepth)) : 0);
}

const FORMATS: Record<NonNullable<SchemaLite["format"]>, (v: string) => boolean> = {
  email: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
  uri: (v) => /^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(v),
  date: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)),
  "date-time": (v) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(v) && !Number.isNaN(Date.parse(v)),
};
const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

type Add = (path: string, msg: string) => void;
const join = (path: string, k: string) => (path ? `${path}.${k}` : k);
const typeOk = (want: SchemaLite["type"], v: unknown) => !want || want === typeOf(v) || (want === "integer" && Number.isInteger(v));

function checkScalar(s: SchemaLite, v: unknown, path: string, add: Add) {
  if (s.enum && !s.enum.some((e) => e === v)) add(path, `must be one of ${s.enum.map((e) => JSON.stringify(e)).join(", ")}`);
  if (s.const !== undefined && s.const !== v) add(path, `must be ${JSON.stringify(s.const)}`);
  if (typeof v === "number") {
    if (s.minimum !== undefined && v < s.minimum) add(path, `must be >= ${s.minimum}`);
    if (s.maximum !== undefined && v > s.maximum) add(path, `must be <= ${s.maximum}`);
  }
  if (typeof v !== "string") return;
  if (s.minLength !== undefined && v.length < s.minLength) add(path, `must be at least ${s.minLength} characters`);
  if (s.maxLength !== undefined && v.length > s.maxLength) add(path, `must be at most ${s.maxLength} characters`);
  if (s.pattern && !new RegExp(s.pattern, "u").test(v.slice(0, 10_000))) add(path, "does not match the required pattern");
  if (s.format && !FORMATS[s.format](v)) add(path, `must be a valid ${s.format}`);
}

function checkCount(s: SchemaLite, n: number, path: string, add: Add) {
  if (s.minItems !== undefined && n < s.minItems) add(path, `must have at least ${s.minItems} items`);
  if (s.maxItems !== undefined && n > s.maxItems) add(path, `must have at most ${s.maxItems} items`);
}

/** Validation errors as `path: message` (empty = valid). Stops after `limit` errors. */
export function validateJson(schema: SchemaLite, value: unknown, limit = 20): string[] {
  const errs: string[] = [];
  const add: Add = (path, msg) => {
    if (errs.length < limit) errs.push(`${path || "$"}: ${msg}`);
  };
  const walk = (s: SchemaLite, v: unknown, path: string, depth: number): void => {
    if (depth > 8 || errs.length >= limit) return;
    if (!typeOk(s.type, v)) return add(path, `must be ${s.type}`);
    checkScalar(s, v, path, add);
    if (Array.isArray(v)) {
      checkCount(s, v.length, path, add);
      if (s.items) v.slice(0, 1000).forEach((x, i) => walk(s.items!, x, `${path}[${i}]`, depth + 1));
    } else if (typeOf(v) === "object") {
      const o = v as Record<string, unknown>;
      for (const r of s.required ?? []) if (!(r in o)) add(join(path, r), "is required");
      for (const [k, sub] of Object.entries(s.properties ?? {})) if (k in o) walk(sub, o[k], join(path, k), depth + 1);
      if (s.additionalProperties === false) for (const k of Object.keys(o)) if (!s.properties?.[k]) add(join(path, k), "is not allowed");
    }
  };
  walk(schema, value, "", 0);
  return errs;
}
