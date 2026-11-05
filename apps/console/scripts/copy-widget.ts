// Copies the built <arag-chat> bundle into public/, where customer sites load it from, and
// records its compressed size for the install guide, so the number the client's web team reads
// is the one they'll measure. A rebuild that changes the bundle shows up as a diff of that file.

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const from = fileURLToPath(new URL("../../../packages/widget/dist/arag-chat.js", import.meta.url));
const to = fileURLToPath(new URL("../public/arag-chat.js", import.meta.url));
mkdirSync(fileURLToPath(new URL("../public", import.meta.url)), { recursive: true });
copyFileSync(from, to);

const kb = Math.round(gzipSync(readFileSync(from), { level: 9 }).length / 1024);
const sizeFile = fileURLToPath(new URL("../src/lib/widget-size.ts", import.meta.url));
const source = `// Written by scripts/copy-widget.ts on each widget build: arag-chat.js gzipped, in KB.\nexport const WIDGET_GZIP_KB = ${kb};\n`;
let current = "";
try {
  current = readFileSync(sizeFile, "utf8").replace(/\r\n/g, "\n");
} catch {
  // First build.
}
if (current !== source) writeFileSync(sizeFile, source);
console.log(`Copied arag-chat.js into public/ (${kb} KB gzipped).`);
