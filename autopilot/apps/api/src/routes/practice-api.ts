/** Mounts the practice co-pilot routers behind practice-staff authentication (ADR 0024). */
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../env.js";
import { validationHook } from "../lib/route.js";
import { noReadonlyWrites, practicePrincipal } from "../lib/practice.js";
import { rateLimit } from "../lib/ratelimit.js";
import { practice } from "./practice.js";
import { work } from "./practice-work.js";
import { onboard } from "./practice-onboard.js";
import { portal } from "./portal.js";

export const practiceApi = new OpenAPIHono<AppEnv>({ defaultHook: validationHook as never });
for (const path of ["/practice", "/practice/*"]) practiceApi.use(path, practicePrincipal, noReadonlyWrites, rateLimit);
practiceApi.route("/", practice);
practiceApi.route("/", work);
practiceApi.route("/", onboard);
practiceApi.route("/", portal);
