// Bundle budget gate for the web app (gzip sizes). Run after `npm run build -w apps/web`.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
const BUDGET = { js: 80 * 1024, css: 10 * 1024, total: 90 * 1024 }; // gzip bytes
const dir = "apps/web/dist/assets";
const files = readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile());
const size = (ext) => files.filter((f) => f.endsWith(ext)).reduce((a, f) => a + gzipSync(readFileSync(join(dir, f))).length, 0);
const js = size(".js"),
  css = size(".css"),
  total = js + css;
const kb = (n) => (n / 1024).toFixed(1) + " KB";
console.log(`bundle (gzip): js ${kb(js)} / ${kb(BUDGET.js)}, css ${kb(css)} / ${kb(BUDGET.css)}, total ${kb(total)} / ${kb(BUDGET.total)}`);
if (js > BUDGET.js || css > BUDGET.css || total > BUDGET.total) {
  console.error("bundle budget exceeded");
  process.exit(1);
}
