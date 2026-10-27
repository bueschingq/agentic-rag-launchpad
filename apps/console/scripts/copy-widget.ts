// Copies the built <arag-chat> bundle into public/, where customer sites load it from.

import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const from = fileURLToPath(new URL("../../../packages/widget/dist/arag-chat.js", import.meta.url));
const to = fileURLToPath(new URL("../public/arag-chat.js", import.meta.url));
mkdirSync(fileURLToPath(new URL("../public", import.meta.url)), { recursive: true });
copyFileSync(from, to);
console.log("Copied arag-chat.js into public/.");
