import { describe, it, expect } from "vitest";
import { parseSse } from "../src/live";

describe("parseSse", () => {
  it("parses complete blocks and keeps the partial tail", () => {
    const p = parseSse('retry: 2000\n\nid: c1\nevent: change\ndata: {"id":"a"}\n\nevent: end\ndata: {}\n\nid: c2\nevent: cha');
    expect(p.events).toEqual([
      { id: "c1", event: "change", data: '{"id":"a"}' },
      { event: "end", data: "{}" },
    ]);
    expect(p.rest).toBe("id: c2\nevent: cha");
    expect(parseSse("").events).toEqual([]);
    expect(parseSse("event:x\ndata:1\n\n").events).toEqual([{ event: "x", data: "1" }]);
  });
});
