// Bundles <arag-chat> into one classic script (IIFE) so `document.currentScript` works in the
// embed snippet, and enforces the size budget from DESIGN.md §6. The stylesheet in styles.ts is
// minified as CSS on the way (its comments and indentation are for people), which keeps about a
// kilobyte gzipped for the verdict's languages.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build, type Plugin, transform } from "esbuild";

const BUDGET_GZIP_BYTES = 45 * 1024;
const outfile = fileURLToPath(new URL("./dist/arag-chat.js", import.meta.url));

// The one `/* css */ \`…\`` template in styles.ts, which holds no interpolation.
const minifyStyles: Plugin = {
  name: "minify-styles",
  setup(b) {
    b.onLoad({ filter: /[\\/]src[\\/]styles\.ts$/ }, async (args) => {
      const source = readFileSync(args.path, "utf8");
      const found = /\/\* css \*\/ `([^`$]*)`/.exec(source);
      if (!found) throw new Error("styles.ts: no /* css */ template to minify");
      const css = (await transform(found[1]!, { loader: "css", minify: true })).code.trim();
      return { contents: source.replace(found[0], () => JSON.stringify(css)), loader: "ts" };
    });
  },
};

await build({
  entryPoints: [fileURLToPath(new URL("./src/index.ts", import.meta.url))],
  bundle: true,
  format: "iife",
  minify: true,
  target: ["es2022"],
  outfile,
  legalComments: "none",
  banner: { js: "/*! arag-chat · Agentic RAG Launchpad · Apache-2.0 */" },
  plugins: [minifyStyles],
});

const gzip = gzipSync(readFileSync(outfile)).length;
console.log(`arag-chat.js: ${(gzip / 1024).toFixed(1)} KB gzipped (budget ${BUDGET_GZIP_BYTES / 1024} KB)`);
if (gzip > BUDGET_GZIP_BYTES) {
  console.error("Over the widget size budget.");
  process.exit(1);
}
