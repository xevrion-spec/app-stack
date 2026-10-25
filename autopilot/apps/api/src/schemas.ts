import { z } from "@hono/zod-openapi";

export const ErrorSchema = z
  .object({
    error: z.object({ code: z.string(), message: z.string(), requestId: z.string(), details: z.unknown().optional() }),
  })
  .openapi("Error");

export const PageQuery = z.object({
  cursor: z.string().optional().openapi({ description: "Opaque cursor from previous page" }),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const page = <T extends z.ZodTypeAny>(item: T, name: string) => z.object({ items: z.array(item), nextCursor: z.string().nullable() }).openapi(name);

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "yyyy-mm-dd");

export const TenantSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    trading_type: z.string(),
    vat_registered: z.number().int(),
    vat_scheme: z.string().nullable(),
    vat_basis: z.string().nullable(),
    flat_rate_percent: z.number().nullable(),
    plan: z.string().nullable(),
  })
  .openapi("Tenant");
export const CreateTenantBody = z
  .object({
    name: z.string().min(1).max(120),
    vatRegistered: z.boolean().default(false),
    vatScheme: z.enum(["standard", "cash", "flat_rate"]).nullable().default(null),
    flatRatePercent: z.number().gt(0).lt(100).nullable().default(null),
  })
  .openapi("CreateTenant");
export const UpdateTenantBody = CreateTenantBody.partial().openapi("UpdateTenant");

export const UserSchema = z.object({ id: z.string(), email: z.string(), role: z.string(), display_name: z.string().nullable() }).openapi("User");
export const CreateUserBody = z
  .object({ email: z.string().email(), role: z.enum(["owner", "reviewer", "accountant"]), displayName: z.string().max(80).optional() })
  .openapi("CreateUser");
export const MeSchema = z.object({ userId: z.string(), tenantId: z.string(), email: z.string(), role: z.string() }).openapi("Me");

export const TransactionSchema = z
  .object({
    id: z.string(),
    txn_date: z.string(),
    description: z.string().nullable(),
    amount_pence: z.number().int(),
    currency: z.string().nullable(),
    status: z.string().nullable(),
    category_code: z.string().nullable(),
    confidence: z.number().nullable(),
    vat_rate_code: z.string().nullable(),
    vat_pence: z.number().int().nullable(),
    document_id: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi("Transaction");
export const CategoriseBody = z
  .object({
    categoryCode: z.string().min(1).max(10),
    vatRateCode: z.enum(["STD", "RED", "ZERO", "EXEMPT", "OUTSIDE"]).nullable().default(null),
    vatPence: z.number().int().min(0).default(0),
    createRule: z.boolean().default(false),
  })
  .openapi("Categorise");

export const CategorySchema = z
  .object({ code: z.string(), name: z.string(), kind: z.string(), sa_box: z.string().nullable(), default_vat_rate_code: z.string().nullable() })
  .openapi("Category");
export const CreateCategoryBody = z
  .object({
    code: z.string().regex(/^\d{4}$/),
    name: z.string().min(1).max(60),
    kind: z.enum(["income", "expense", "asset", "liability", "equity"]),
    saBox: z.string().max(40).nullable().default(null),
    defaultVatRateCode: z.string().max(10).nullable().default(null),
  })
  .openapi("CreateCategory");
export const RuleSchema = z
  .object({
    id: z.string(),
    pattern: z.string(),
    match_type: z.string(),
    category_code: z.string(),
    vat_rate_code: z.string().nullable(),
    priority: z.number().int(),
  })
  .openapi("Rule");
export const CreateRuleBody = z
  .object({
    pattern: z.string().min(2).max(80),
    matchType: z.enum(["contains", "prefix", "exact", "regex"]).default("contains"),
    categoryCode: z.string().min(1).max(10),
    vatRateCode: z.string().max(10).nullable().default(null),
    priority: z.number().int().min(0).max(1000).default(100),
  })
  .openapi("CreateRule");

const InvoiceLine = z.object({
  description: z.string().min(1).max(200),
  quantity: z.number().positive(),
  unitPence: z.number().int().nonnegative(),
  vatRateCode: z.enum(["STD", "RED", "ZERO", "EXEMPT", "OUTSIDE"]),
});
export const CreateInvoiceBody = z
  .object({
    customerName: z.string().min(1).max(120),
    customerEmail: z.string().email().optional(),
    issueDate: isoDate,
    dueDate: isoDate,
    lines: z.array(InvoiceLine).min(1).max(100),
  })
  .openapi("CreateInvoice");
export const InvoiceSchema = z
  .object({
    id: z.string(),
    number: z.string(),
    customer_name: z.string(),
    customer_email: z.string().nullable(),
    issue_date: z.string(),
    due_date: z.string(),
    status: z.string(),
    net_pence: z.number().int(),
    vat_pence: z.number().int(),
    gross_pence: z.number().int(),
    lines_json: z.string(),
  })
  .openapi("Invoice");
export const InvoiceStatusBody = z.object({ status: z.enum(["sent", "paid", "void"]), paidTransactionId: z.string().optional() }).openapi("InvoiceStatus");

export const VatDraftBody = z
  .object({ periodStart: isoDate, periodEnd: isoDate, scheme: z.enum(["standard", "cash", "flat_rate"]).optional() })
  .openapi("VatDraftRequest");
export const VatDraftSchema = z
  .object({
    id: z.string(),
    scheme: z.string(),
    periodStart: z.string(),
    periodEnd: z.string(),
    box1: z.number().int(),
    box2: z.number().int(),
    box3: z.number().int(),
    box4: z.number().int(),
    box5: z.number().int(),
    box6: z.number().int(),
    box7: z.number().int(),
    box8: z.number().int(),
    box9: z.number().int(),
    status: z.literal("draft"),
    ratesVerified: z.literal(false),
    warnings: z.array(z.string()),
  })
  .openapi("VatDraft");

export const SaQuery = z.object({ taxYearStart: isoDate.default("2026-04-06"), taxYearEnd: isoDate.default("2027-04-05") });

export const ExceptionSchema = z
  .object({
    id: z.string(),
    job_id: z.string(),
    stage: z.string(),
    reason: z.string(),
    reason_code: z.string().nullable(),
    subject_type: z.string().nullable(),
    subject_id: z.string().nullable(),
    status: z.string(),
    created_at: z.string(),
  })
  .openapi("Exception");
export const ResolveExceptionBody = z
  .object({
    decision: z.enum(["approve", "override", "dismiss"]),
    note: z.string().max(500).optional(),
    override: z.object({ categoryCode: z.string(), vatRateCode: z.string().nullable().optional(), vatPence: z.number().int().min(0).optional() }).optional(),
  })
  .openapi("ResolveException");

export const JobSchema = z
  .object({ id: z.string(), kind: z.string(), period: z.string().nullable(), status: z.string(), qa_score: z.number().nullable(), created_at: z.string() })
  .openapi("Job");
export const JobEventSchema = z
  .object({ id: z.string(), stage: z.string(), status: z.string(), detail: z.string().nullable(), created_at: z.string() })
  .openapi("JobEvent");

export const UploadResult = z
  .object({
    documentId: z.string(),
    sha256: z.string(),
    jobId: z.string().nullable(),
    inserted: z.number().int(),
    duplicates: z.number().int(),
    rejectedRows: z.array(z.object({ row: z.number(), error: z.string() })),
  })
  .openapi("UploadResult");
