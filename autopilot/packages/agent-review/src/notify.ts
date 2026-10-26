/**
 * R1 reviewer notifications: signed single-use action tokens, Slack request signing, and channel renderers
 * (Slack Block Kit, Teams Adaptive Card, email, generic JSON). Pure and dependency-free (WebCrypto only).
 * Renderers only see a minimised summary (top-level scalar fields, truncated), never the full payload.
 */
export type NotifyDecision = "approve" | "reject";
export interface ActionClaims {
  v: 1;
  tid: string;
  rid: string;
  d: NotifyDecision;
  u: string;
  exp: number;
  n: string;
}
const enc = new TextEncoder();
const b64u = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
async function hmac(secret: string, msg: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}
function safeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

export async function signAction(c: ActionClaims, secret: string): Promise<string> {
  const body = b64u(enc.encode(JSON.stringify(c)));
  return `${body}.${b64u(await hmac(secret, body))}`;
}
export type ActionVerdict = { ok: true; claims: ActionClaims } | { ok: false; reason: "malformed" | "bad_signature" | "expired" };
export async function verifyAction(token: string, secret: string, nowSec: number): Promise<ActionVerdict> {
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return { ok: false, reason: "malformed" };
  let given: Uint8Array;
  let claims: ActionClaims;
  try {
    given = unb64u(sig);
    claims = JSON.parse(new TextDecoder().decode(unb64u(body))) as ActionClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!safeEqual(given, await hmac(secret, body))) return { ok: false, reason: "bad_signature" };
  if (claims.v !== 1 || (claims.d !== "approve" && claims.d !== "reject") || typeof claims.exp !== "number") return { ok: false, reason: "malformed" };
  if (claims.exp < nowSec) return { ok: false, reason: "expired" };
  return { ok: true, claims };
}

/** Slack signing secret check: v0=hex(hmac("v0:{ts}:{body}")), 5-minute replay window. */
export async function verifySlackSignature(secret: string, ts: string | null, body: string, sig: string | null, nowSec: number): Promise<boolean> {
  if (!ts || !sig || !/^\d+$/.test(ts) || Math.abs(nowSec - Number(ts)) > 300) return false;
  const want = enc.encode(`v0=${hex(await hmac(secret, `v0:${ts}:${body}`))}`);
  return safeEqual(enc.encode(sig), want);
}
export async function slackSignature(secret: string, ts: string, body: string): Promise<string> {
  return `v0=${hex(await hmac(secret, `v0:${ts}:${body}`))}`;
}

export interface NotifyInput {
  requestId: string;
  action: string;
  risk: string;
  project: string;
  deadlineAt: string;
  summary: [string, string][];
  openUrl: string;
  approveUrl?: string;
  rejectUrl?: string;
}
const MAX_FIELDS = 8;
const MAX_VALUE = 80;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** Top-level scalar fields only, keys sorted, values truncated; objects/arrays shown as their type. */
export function summarise(payload: unknown): [string, string][] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  return Object.keys(payload as Record<string, unknown>)
    .sort()
    .slice(0, MAX_FIELDS)
    .map((k) => {
      const v = (payload as Record<string, unknown>)[k];
      const shown = v === null ? "null" : typeof v === "object" ? (Array.isArray(v) ? `[${v.length} items]` : "{…}") : String(v);
      return [clip(k, 40), clip(shown, MAX_VALUE)];
    });
}
const slackEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const htmlEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const title = (n: NotifyInput) => `Review needed: ${n.action} (${n.risk} risk) in ${n.project}`;

export function renderSlack(n: NotifyInput, tokens: { approve: string; reject: string } | null) {
  const fields = n.summary.map(([k, v]) => ({ type: "mrkdwn", text: `*${slackEsc(k)}*\n${slackEsc(v)}` }));
  const buttons = [
    ...(tokens
      ? [
          { type: "button", style: "primary", text: { type: "plain_text", text: "Approve" }, action_id: "review_approve", value: tokens.approve },
          { type: "button", style: "danger", text: { type: "plain_text", text: "Reject" }, action_id: "review_reject", value: tokens.reject },
        ]
      : []),
    { type: "button", text: { type: "plain_text", text: "Open" }, action_id: "review_open", url: n.openUrl },
  ];
  return {
    text: title(n),
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*${slackEsc(title(n))}*\nDecide by ${slackEsc(n.deadlineAt)}` } },
      ...(fields.length ? [{ type: "section", fields: fields.slice(0, 10) }] : []),
      { type: "actions", block_id: `review:${n.requestId}`, elements: buttons },
    ],
  };
}

export function renderTeams(n: NotifyInput) {
  const actions = [
    ...(n.approveUrl ? [{ type: "Action.OpenUrl", title: "Approve", url: n.approveUrl }] : []),
    ...(n.rejectUrl ? [{ type: "Action.OpenUrl", title: "Reject", url: n.rejectUrl }] : []),
    { type: "Action.OpenUrl", title: "Open", url: n.openUrl },
  ];
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            { type: "TextBlock", text: title(n), weight: "Bolder", wrap: true },
            { type: "FactSet", facts: n.summary.map(([k, v]) => ({ title: k, value: v })) },
            { type: "TextBlock", text: `Decide by ${n.deadlineAt}`, isSubtle: true, wrap: true },
          ],
          actions,
        },
      },
    ],
  };
}

export function renderEmail(n: NotifyInput) {
  const rows = n.summary.map(([k, v]) => `<tr><th align="left">${htmlEsc(k)}</th><td>${htmlEsc(v)}</td></tr>`).join("");
  const link = (href: string | undefined, label: string) => (href ? `<a href="${htmlEsc(href)}">${label}</a>` : "");
  const links = [link(n.approveUrl, "Approve"), link(n.rejectUrl, "Reject"), link(n.openUrl, "Open in inbox")].filter(Boolean).join(" · ");
  return {
    subject: clip(title(n), 150),
    text: [
      title(n),
      ...n.summary.map(([k, v]) => `${k}: ${v}`),
      `Decide by ${n.deadlineAt}`,
      n.approveUrl ? `Approve: ${n.approveUrl}` : "",
      n.rejectUrl ? `Reject: ${n.rejectUrl}` : "",
      `Open: ${n.openUrl}`,
    ]
      .filter(Boolean)
      .join("\n"),
    html: `<h1>${htmlEsc(title(n))}</h1><table>${rows}</table><p>Decide by ${htmlEsc(n.deadlineAt)}</p><p>${links}</p><p>Links ask you to confirm; opening one never decides on its own.</p>`,
  };
}

export function renderWebhook(n: NotifyInput) {
  return {
    type: "review.notification",
    requestId: n.requestId,
    action: n.action,
    risk: n.risk,
    project: n.project,
    deadlineAt: n.deadlineAt,
    summary: Object.fromEntries(n.summary),
    openUrl: n.openUrl,
  };
}
