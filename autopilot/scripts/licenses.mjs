// Licence gate: every production dependency must use an allow-listed licence. `npm run licenses`
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { readdirSync } from "node:fs";
const ALLOW = new Set([
  "MIT",
  "ISC",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "Unlicense",
  "MIT-0",
  "Python-2.0",
  "CC-BY-4.0",
  "Zlib",
]);
// Packages with no SPDX field, verified by reading their LICENSE file.
const VERIFIED = { unionfs: "Unlicense (LICENSE file, no package.json field)" };
const tree = JSON.parse(execSync("npm ls --omit=dev --all --json", { encoding: "utf8", maxBuffer: 64 << 20 }));
const ROOTS = ["node_modules", ...["apps", "packages"].flatMap((d) => (existsSync(d) ? readdirSync(d).map((w) => join(d, w, "node_modules")) : []))];
const seen = new Map();
(function walk(deps = {}) {
  for (const [name, d] of Object.entries(deps)) {
    if (seen.has(name) || d.extraneous) continue; // npm 10 lists extraneous (not depended-on) optional binaries, e.g. @img/sharp-wasm32
    if (!d.version) {
      walk(d.dependencies);
      continue;
    }
    // Workspaces can nest their own copy (e.g. apps/api/node_modules); check root first, then each workspace.
    const p = ROOTS.map((r) => join(r, name, "package.json")).find((x) => existsSync(x)) ?? "";
    const pkg = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
    const lic = typeof pkg.license === "string" ? pkg.license : (pkg.license?.type ?? "UNKNOWN");
    seen.set(name, lic);
    walk(d.dependencies);
  }
})(tree.dependencies);
const ok = (l) =>
  l
    .replace(/[()]/g, "")
    .split(/\s+OR\s+/)
    .some((x) => x.split(/\s+AND\s+/).every((y) => ALLOW.has(y.trim())));
const bad = [...seen].filter(([n, l]) => !n.startsWith("@xevrion/") && !(n in VERIFIED) && !ok(l));
console.log(`licences: ${seen.size} production packages checked`);
if (bad.length) {
  for (const [n, l] of bad) console.error(`  disallowed: ${n} (${l})`);
  process.exit(1);
}
