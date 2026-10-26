/**
 * Wake-up bus: waiters sleep until either a publish on their key or a timeout, whichever comes first.
 * It carries no data (readers re-query the database), so a missed or cross-isolate publish only costs
 * latency (the poll fallback still fires), never correctness.
 */
export interface WakeBus {
  publish(key: string): number;
  wait(key: string, ms: number): Promise<boolean>;
  size(): number;
}

export function createBus(): WakeBus {
  const waiters = new Map<string, Set<(woken: boolean) => void>>();
  const drop = (key: string, fn: (w: boolean) => void) => {
    const set = waiters.get(key);
    if (!set) return;
    set.delete(fn);
    if (set.size === 0) waiters.delete(key);
  };
  return {
    publish(key) {
      const set = waiters.get(key);
      if (!set) return 0;
      waiters.delete(key);
      for (const fn of set) fn(true);
      return set.size;
    },
    wait(key, ms) {
      return new Promise<boolean>((resolve) => {
        const fn = (woken: boolean) => {
          clearTimeout(timer);
          drop(key, fn);
          resolve(woken);
        };
        const timer = setTimeout(() => fn(false), Math.max(0, ms));
        let set = waiters.get(key);
        if (!set) waiters.set(key, (set = new Set()));
        set.add(fn);
      });
    },
    size() {
      let n = 0;
      for (const s of waiters.values()) n += s.size;
      return n;
    },
  };
}

/** Opaque resume cursor for the tenant feed: `<updatedAt>|<id>`, base64url. */
export const encodeCursor = (updatedAt: string, id: string) => btoa(`${updatedAt}|${id}`).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export function decodeCursor(c: string | null | undefined): { updatedAt: string; id: string } | null {
  if (!c || !/^[A-Za-z0-9_-]{1,200}$/.test(c)) return null;
  let s: string;
  try {
    s = atob(c.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return null;
  }
  const i = s.indexOf("|");
  if (i <= 0 || i === s.length - 1) return null;
  return { updatedAt: s.slice(0, i), id: s.slice(i + 1) };
}

/** Order of two cursors by (updatedAt, id): negative when a is earlier. Unparseable cursors sort first. */
export function compareCursors(a: string, b: string): number {
  const x = decodeCursor(a);
  const y = decodeCursor(b);
  if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0);
  return x.updatedAt < y.updatedAt ? -1 : x.updatedAt > y.updatedAt ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
}
