import { z } from "zod";

/**
 * Business-hours SLA clock (R3). A project calendar says when people are expected to review; timeouts and escalations
 * with `clock: "business"` count only those hours. Pure and time-zone correct (Intl), including DST changes.
 */
const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM, 24-hour");
export const Calendar = z
  .object({
    timeZone: z.string().min(1).max(64).refine(validZone, "unknown IANA time zone"),
    /** ISO weekdays: 1 = Monday … 7 = Sunday. */
    days: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    start: HHMM,
    end: HHMM,
    holidays: z
      .array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
      .max(366)
      .default([]),
  })
  .refine((c) => c.end > c.start, { message: "end must be after start", path: ["end"] });
export type Calendar = z.infer<typeof Calendar>;

function validZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const fmt = new Map<string, Intl.DateTimeFormat>();
function parts(t: number, tz: string) {
  let f = fmt.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    fmt.set(tz, f);
  }
  const o: Record<string, number> = {};
  for (const p of f.formatToParts(t)) if (p.type !== "literal") o[p.type] = Number(p.value);
  return { y: o.year!, m: o.month!, d: o.day!, h: o.hour!, mi: o.minute!, s: o.second! };
}
/** Offset of `tz` from UTC at instant t, in ms. */
function offset(t: number, tz: string): number {
  const p = parts(t, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(t / 1000) * 1000;
}
/** UTC instant of a local wall time. DST gaps and repeated hours both resolve to the later instant (never early). */
export function zonedToUtc(y: number, m: number, d: number, hh: number, mm: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const o1 = offset(guess, tz);
  // Re-reading the offset at the first estimate settles DST edges (equal offsets mean the estimate was already right).
  return guess - offset(guess - o1, tz);
}
const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** Business windows [open, close) in order, starting with the local day that contains `from` (about two years). */
function* windows(from: number, cal: Calendar): Generator<[number, number]> {
  const p = parts(from, cal.timeZone);
  const holidays = new Set(cal.holidays);
  const [sh, sm] = cal.start.split(":").map(Number) as [number, number];
  const [eh, em] = cal.end.split(":").map(Number) as [number, number];
  for (let i = 0, day = Date.UTC(p.y, p.m - 1, p.d); i < 800; i++, day += 86_400_000) {
    const dt = new Date(day);
    const [y, m, d] = [dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()];
    if (cal.days.includes(dt.getUTCDay() || 7) && !holidays.has(iso(y, m, d)))
      yield [zonedToUtc(y, m, d, sh, sm, cal.timeZone), zonedToUtc(y, m, d, eh, em, cal.timeZone)];
  }
}

/** The instant `seconds` business-seconds after `from`. Throws if the calendar has no open time within ~2 years. */
export function addBusinessSeconds(from: number, seconds: number, cal: Calendar): number {
  let remaining = Math.max(0, seconds) * 1000;
  for (const [open, close] of windows(from, cal)) {
    const cur = Math.max(from, open);
    if (cur >= close) continue;
    if (remaining <= close - cur) return cur + remaining;
    remaining -= close - cur;
  }
  throw new RangeError("calendar has no business hours in range");
}

/** Business seconds elapsed between two instants (for SLA reporting). */
export function businessSecondsBetween(a: number, b: number, cal: Calendar): number {
  let total = 0;
  for (const [open, close] of windows(a, cal)) {
    if (open >= b) break;
    total += Math.max(0, Math.min(close, b) - Math.max(open, a));
  }
  return Math.round(total / 1000);
}
