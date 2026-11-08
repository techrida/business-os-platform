// Builds one self-contained page (model inlined) for publishing: dist/system-map.html
// Run: node architecture/build.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const html = readFileSync(here("./map.html"), "utf8");
const model = readFileSync(here("./model.js"), "utf8").replace(/<\/script/gi, "<\\/script");
const marker = '<script src="https://cdn.jsdelivr.net/npm/elkjs@';
const at = html.indexOf(marker);
if (at < 0) throw new Error("ELK script tag not found in map.html");
const out = html.slice(0, at) + `<script>\n${model}\n</script>\n` + html.slice(at);
mkdirSync(here("../dist"), { recursive: true });
writeFileSync(here("../dist/system-map.html"), out);
console.log(`dist/system-map.html written (${out.length} bytes)`);
