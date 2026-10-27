// Bundles <arag-chat> into one classic script (IIFE) so `document.currentScript` works in the
// embed snippet, and enforces the size budget from DESIGN.md §6.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";

const BUDGET_GZIP_BYTES = 40 * 1024;
const outfile = fileURLToPath(new URL("./dist/arag-chat.js", import.meta.url));

await build({
  entryPoints: [fileURLToPath(new URL("./src/index.ts", import.meta.url))],
  bundle: true,
  format: "iife",
  minify: true,
  target: ["es2022"],
  outfile,
  legalComments: "none",
  banner: { js: "/*! arag-chat · Agentic RAG Launchpad · Apache-2.0 */" },
});

const gzip = gzipSync(readFileSync(outfile)).length;
console.log(`arag-chat.js: ${(gzip / 1024).toFixed(1)} KB gzipped (budget ${BUDGET_GZIP_BYTES / 1024} KB)`);
if (gzip > BUDGET_GZIP_BYTES) {
  console.error("Over the widget size budget.");
  process.exit(1);
}
