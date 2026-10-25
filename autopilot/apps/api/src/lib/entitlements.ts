import type { MiddlewareHandler } from "hono";
import { hasFeature, type Feature } from "@xevrion/platform";
import type { AppEnv } from "../env.js";
import { TenantDb } from "./db.js";
import { AppError } from "./errors.js";

/** 402-style gate (we use 403 `plan_required` so clients do not confuse it with payment flows). */
export function requireFeature(f: Feature): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const plan = (await new TenantDb(c.env.DB, c.get("principal").tenantId).tenantRowStmt("plan").first<{ plan: string | null }>())?.plan ?? "free";
    if (!hasFeature(plan, f)) throw new AppError(403, "plan_required", `Your plan does not include ${f}`, { feature: f, plan });
    return next();
  };
}
