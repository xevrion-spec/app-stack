/** M6: the web CSP stays strict (no unsafe-inline/eval) and the built shell has no inline script/style to need it. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");
describe("web CSP", () => {
  const csp = readFileSync(join(root, "public/_headers"), "utf8").match(/Content-Security-Policy: (.*)/)![1]!;
  it("has no unsafe directives and locks down objects, base and forms", () => {
    expect(csp).not.toMatch(/unsafe-(inline|eval)/);
    for (const d of ["default-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'"]) expect(csp).toContain(d);
  });
  it("index.html has no inline scripts, styles or handlers", () => {
    const html = readFileSync(join(root, "index.html"), "utf8");
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    expect(html).not.toMatch(/<style|\sstyle=|\son[a-z]+=/i);
  });
});
