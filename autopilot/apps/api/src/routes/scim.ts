/**
 * SCIM 2.0 Users (RFC 7643/7644 subset, A8b) for IdP-driven provisioning (Okta, Entra ID). Auth: an API key with the
 * `scim:write` scope (or an owner). Roles map to reviewer|accountant via `roles[0].value`; owners are never created,
 * changed or deactivated over SCIM. Deactivation revokes the user's SSO sessions and blocks every login path.
 * DELETE deactivates (tombstone) so history keeps its actor; the user then reads back as active=false.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env.js";
import { TenantDb, newId } from "../lib/db.js";
import { auditStmt } from "../lib/audit.js";

export const scim = new Hono<AppEnv>();
const SCHEMA_USER = "urn:ietf:params:scim:schemas:core:2.0:User";
const SCHEMA_LIST = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const SCHEMA_ERR = "urn:ietf:params:scim:api:messages:2.0:Error";
const SCHEMA_PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
type C = Context<AppEnv>;
type URow = {
  id: string;
  email: string;
  role: string;
  display_name: string | null;
  external_id: string | null;
  deactivated_at: string | null;
  created_at: string | null;
};
const COLS = "id, email, role, display_name, external_id, deactivated_at, created_at";
const SCIM_ROLES = ["reviewer", "accountant"] as const;

const err = (c: C, status: 400 | 403 | 404 | 409, detail: string, scimType?: string) =>
  c.json({ schemas: [SCHEMA_ERR], status: String(status), detail, ...(scimType ? { scimType } : {}) }, status, { "content-type": "application/scim+json" });
const ok = (c: C, body: unknown, status: 200 | 201 = 200) => c.json(body, status, { "content-type": "application/scim+json" });
const db = (c: C) => new TenantDb(c.env.DB, c.get("principal").tenantId);
const actor = (c: C) => c.get("principal").email;
const toScim = (u: URow, base: string) => ({
  schemas: [SCHEMA_USER],
  id: u.id,
  userName: u.email,
  ...(u.external_id ? { externalId: u.external_id } : {}),
  ...(u.display_name ? { displayName: u.display_name, name: { formatted: u.display_name } } : {}),
  emails: [{ value: u.email, primary: true }],
  active: !u.deactivated_at,
  roles: [{ value: u.role, primary: true }],
  meta: { resourceType: "User", location: `${base}/Users/${u.id}`, ...(u.created_at ? { created: u.created_at } : {}) },
});
const base = (c: C) => `${new URL(c.req.url).origin}/v1/scim/v2`;

scim.use("*", async (c, next) => {
  const p = c.get("principal");
  if (!p.apiKey && p.role !== "owner") return err(c, 403, "SCIM requires an owner or a scim:write API key");
  return next();
});

const UserIn = z.object({
  userName: z.string().email().max(320),
  externalId: z.string().max(200).optional(),
  displayName: z.string().max(200).optional(),
  name: z
    .object({ formatted: z.string().max(200).optional(), givenName: z.string().max(100).optional(), familyName: z.string().max(100).optional() })
    .optional(),
  active: z.boolean().default(true),
  roles: z
    .array(z.object({ value: z.string() }))
    .max(5)
    .optional(),
});
const roleOf = (roles?: { value: string }[]) => {
  const r = roles?.[0]?.value?.toLowerCase();
  if (r === undefined) return "reviewer";
  return (SCIM_ROLES as readonly string[]).includes(r) ? r : null;
};
const nameOf = (b: z.infer<typeof UserIn>) => b.displayName ?? b.name?.formatted ?? ([b.name?.givenName, b.name?.familyName].filter(Boolean).join(" ") || null);

async function load(c: C, id: string) {
  return db(c).first<URow>(`select ${COLS} from users where tenant_id = ?1 and id = ?2`, id);
}
async function setActive(c: C, u: URow, active: boolean) {
  const d = db(c);
  const t = new Date().toISOString();
  if (active === !u.deactivated_at) return;
  await d.batch([
    d.stmt("update users set deactivated_at = ?3 where tenant_id = ?1 and id = ?2", u.id, active ? null : t),
    ...(active ? [] : [d.stmt("update sso_sessions set revoked_at = ?3 where tenant_id = ?1 and email = ?2 and revoked_at is null", u.email, t)]),
    auditStmt(d, actor(c), active ? "user.reactivated" : "user.deactivated", u.id, { via: "scim", email: u.email }),
  ]);
}

scim.get("/Users", async (c) => {
  const filter = c.req.query("filter");
  const startIndex = Math.max(1, Number(c.req.query("startIndex") ?? 1) || 1);
  const count = Math.min(200, Math.max(0, Number(c.req.query("count") ?? 100) || 0));
  let where = "";
  const args: unknown[] = [];
  if (filter) {
    // the filters IdPs actually send: userName eq "..." and externalId eq "..."
    const m = /^\s*(userName|externalId)\s+eq\s+"([^"]{1,320})"\s*$/i.exec(filter);
    if (!m) return err(c, 400, "Only `userName eq` and `externalId eq` filters are supported", "invalidFilter");
    where = m[1]!.toLowerCase() === "username" ? " and email = ?2" : " and external_id = ?2";
    args.push(m[1]!.toLowerCase() === "username" ? m[2]!.toLowerCase() : m[2]);
  }
  const d = db(c);
  const total = (await d.first<{ n: number }>(`select count(*) n from users where tenant_id = ?1${where}`, ...args))?.n ?? 0;
  const rows = await d.all<URow>(
    `select ${COLS} from users where tenant_id = ?1${where} order by created_at, id limit ?${args.length + 2} offset ?${args.length + 3}`,
    ...args,
    count,
    startIndex - 1,
  );
  return ok(c, { schemas: [SCHEMA_LIST], totalResults: total, startIndex, itemsPerPage: rows.length, Resources: rows.map((r) => toScim(r, base(c))) });
});

scim.get("/Users/:id", async (c) => {
  const u = await load(c, c.req.param("id"));
  return u ? ok(c, toScim(u, base(c))) : err(c, 404, "User not found");
});

scim.post("/Users", async (c) => {
  const p = UserIn.safeParse(await c.req.json().catch(() => null));
  if (!p.success) return err(c, 400, p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), "invalidValue");
  const role = roleOf(p.data.roles);
  if (!role) return err(c, 400, "roles[0].value must be reviewer or accountant", "invalidValue");
  const email = p.data.userName.toLowerCase();
  const d = db(c);
  if (await d.first("select 1 from users where tenant_id = ?1 and email = ?2", email)) return err(c, 409, "User already exists", "uniqueness");
  const id = newId();
  await d.batch([
    d.stmt(
      "insert into users (tenant_id, id, email, role, display_name, external_id, deactivated_at) values (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
      id,
      email,
      role,
      nameOf(p.data),
      p.data.externalId ?? null,
      p.data.active ? null : new Date().toISOString(),
    ),
    auditStmt(d, actor(c), "user.provisioned", id, { via: "scim", email, role }),
  ]);
  return ok(c, toScim((await load(c, id))!, base(c)), 201);
});

async function guardOwner(c: C, u: URow | null) {
  if (!u) return err(c, 404, "User not found");
  if (u.role === "owner") return err(c, 403, "Owners cannot be managed over SCIM");
  return null;
}

scim.put("/Users/:id", async (c) => {
  const u = await load(c, c.req.param("id"));
  const g = await guardOwner(c, u);
  if (g) return g;
  const p = UserIn.safeParse(await c.req.json().catch(() => null));
  if (!p.success) return err(c, 400, "Invalid user", "invalidValue");
  const role = roleOf(p.data.roles);
  if (!role) return err(c, 400, "roles[0].value must be reviewer or accountant", "invalidValue");
  if (p.data.userName.toLowerCase() !== u!.email) return err(c, 400, "userName cannot change (create a new user instead)", "mutability");
  const d = db(c);
  await d.batch([
    d.stmt(
      "update users set role = ?3, display_name = ?4, external_id = ?5 where tenant_id = ?1 and id = ?2",
      u!.id,
      role,
      nameOf(p.data),
      p.data.externalId ?? u!.external_id,
    ),
    auditStmt(d, actor(c), "user.updated", u!.id, { via: "scim", role }),
  ]);
  await setActive(c, (await load(c, u!.id))!, p.data.active);
  return ok(c, toScim((await load(c, u!.id))!, base(c)));
});

const PatchIn = z.object({
  schemas: z.array(z.string()).refine((s) => s.includes(SCHEMA_PATCH), "PatchOp schema required"),
  Operations: z
    .array(z.object({ op: z.string(), path: z.string().optional(), value: z.unknown() }))
    .min(1)
    .max(20),
});
type Ops = z.infer<typeof PatchIn>["Operations"];
type Parsed = { active?: boolean; role?: string; displayName?: string } | { error: string; scimType: string };
/** Both shapes IdPs send: {path:"active", value:false} and {value:{active:false}}. */
function parseOps(ops: Ops): Parsed {
  const out: { active?: boolean; role?: string; displayName?: string } = {};
  for (const o of ops) {
    if (!["replace", "add"].includes(o.op.toLowerCase())) return { error: `Unsupported op ${o.op}`, scimType: "invalidSyntax" };
    const v = (o.path ? { [o.path]: o.value } : (o.value as Record<string, unknown>)) ?? {};
    for (const [k, val] of Object.entries(v)) {
      if (k === "active") out.active = val === true || val === "True" || val === "true";
      else if (k === "displayName" && typeof val === "string") out.displayName = val.slice(0, 200);
      else if (k === "roles" && Array.isArray(val)) {
        const r = roleOf(val as { value: string }[]);
        if (!r) return { error: "roles[0].value must be reviewer or accountant", scimType: "invalidValue" };
        out.role = r;
      } else return { error: `Unsupported attribute ${k}`, scimType: "invalidPath" };
    }
  }
  return out;
}
scim.patch("/Users/:id", async (c) => {
  const u = await load(c, c.req.param("id"));
  const g = await guardOwner(c, u);
  if (g) return g;
  const p = PatchIn.safeParse(await c.req.json().catch(() => null));
  if (!p.success) return err(c, 400, "Invalid PatchOp", "invalidSyntax");
  const parsed = parseOps(p.data.Operations);
  if ("error" in parsed) return err(c, 400, parsed.error, parsed.scimType);
  const { active, role, displayName } = parsed;
  const d = db(c);
  if (role || displayName !== undefined)
    await d.batch([
      d.stmt(
        "update users set role = coalesce(?3, role), display_name = coalesce(?4, display_name) where tenant_id = ?1 and id = ?2",
        u!.id,
        role ?? null,
        displayName ?? null,
      ),
      auditStmt(d, actor(c), "user.updated", u!.id, { via: "scim", ...(role ? { role } : {}) }),
    ]);
  if (active !== undefined) await setActive(c, (await load(c, u!.id))!, active);
  return ok(c, toScim((await load(c, u!.id))!, base(c)));
});

scim.delete("/Users/:id", async (c) => {
  const u = await load(c, c.req.param("id"));
  const g = await guardOwner(c, u);
  if (g) return g;
  await setActive(c, u!, false);
  return c.body(null, 204);
});

scim.get("/ServiceProviderConfig", (c) =>
  ok(c, {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [{ type: "oauthbearertoken", name: "API key", description: "Bearer API key with the scim:write scope" }],
  }),
);
