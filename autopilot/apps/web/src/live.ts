import { useEffect, useRef, useState } from "react";
import { raw } from "./api";

export type FeedChange = { id: string; status: string; version: number; cursor: string };

/** Parses complete SSE blocks out of `buf`; returns the parsed events and the unconsumed tail. */
export function parseSse(buf: string): { events: { id?: string; event: string; data: string }[]; rest: string } {
  const blocks = buf.split("\n\n");
  const rest = blocks.pop() ?? "";
  const events = [];
  for (const b of blocks) {
    const f: Record<string, string> = {};
    for (const line of b.split("\n")) {
      const i = line.indexOf(":");
      if (i > 0) f[line.slice(0, i)] = line.slice(i + 1).trimStart();
    }
    if (f.event && f.data !== undefined) events.push({ ...(f.id ? { id: f.id } : {}), event: f.event, data: f.data });
  }
  return { events, rest };
}

/** Applies one stream event; returns the cursor to resume from. */
function handle(e: { id?: string; event: string; data: string }, cursor: string, onChange: (c: FeedChange) => void): string {
  if (e.event === "change") onChange(JSON.parse(e.data) as FeedChange);
  if (e.event === "end") return (JSON.parse(e.data) as { cursor?: string }).cursor || e.id || cursor;
  return e.id || cursor;
}

/**
 * Live inbox: follows /v1/agent-review/events/stream with a streamed fetch (so dev auth headers and cookies both work),
 * reconnecting from the last cursor with backoff. Returns whether the stream is currently connected.
 */
export function useLiveFeed(onChange: (c: FeedChange) => void): boolean {
  const [live, setLive] = useState(false);
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => {
    const ctl = new AbortController();
    let cursor = "";
    let backoff = 1000;
    const run = async () => {
      while (!ctl.signal.aborted) {
        try {
          const res = await raw(`/v1/agent-review/events/stream${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, { signal: ctl.signal });
          const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
          setLive(true);
          backoff = 1000;
          let buf = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            const p = parseSse(buf + value);
            buf = p.rest;
            for (const e of p.events) cursor = handle(e, cursor, cb.current);
          }
        } catch {
          if (ctl.signal.aborted) return;
          setLive(false);
          await new Promise((r) => setTimeout(r, backoff));
          backoff = Math.min(backoff * 2, 30_000);
        }
      }
    };
    void run();
    return () => ctl.abort();
  }, []);
  return live;
}
