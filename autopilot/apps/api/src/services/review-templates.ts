import * as R from "@xevrion/agent-review";
import type { TenantDb } from "../lib/db.js";
import { AppError } from "../lib/errors.js";

export type TemplateRow = { action: string; title: string | null; instructions: string | null; schema_json: string; updated_by: string; updated_at: string };
export const TEMPLATE_COLS = "action, title, instructions, schema_json, updated_by, updated_at";

/** Refuses a payload that breaks the project's template for this action (no template = anything goes). */
export async function checkTemplate(db: TenantDb, projectId: string, action: string, payload: unknown): Promise<void> {
  const t = await db.first<{ schema_json: string }>(
    "select schema_json from review_action_templates where tenant_id = ?1 and project_id = ?2 and action = ?3",
    projectId,
    action,
  );
  if (!t) return;
  const errors = R.validateJson(JSON.parse(t.schema_json) as R.SchemaLite, payload);
  if (errors.length) throw new AppError(422, "payload_invalid", `Payload does not match the ${action} template: ${errors.join("; ")}`);
}

/** Title with `{{field}}` placeholders filled from top-level scalars of the payload (clipped). */
export function renderTitle(title: string | null, payload: Record<string, unknown>): string | null {
  if (!title) return null;
  return title.replace(/\{\{\s*([A-Za-z0-9_]{1,64})\s*\}\}/g, (_, k: string) => {
    const v = payload[k];
    return v === null || ["string", "number", "boolean"].includes(typeof v) ? String(v).slice(0, 80) : "…";
  });
}
