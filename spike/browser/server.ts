// Browser half of the M0 spike: proves the planned widget flow end to end.
//
//   node spike/browser/server.ts
//
// Serves the same test page on two origins:
//   http://localhost:4173  — listed in the spike KB's allowed_origins
//   http://localhost:4174  — not listed, so the browser should be blocked
// POST /token mints a 10-second temporal key from the reader key, server-side, exactly as the
// console's public token endpoint will. The page then streams /ask straight from Agentic RAG.

import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { ROOT, readSecrets, readState, zoneApi } from "../lib.ts";

const PAGE = join(ROOT, "spike", "browser", "index.html");

async function handle(req: IncomingMessage, res: ServerResponse, port: number) {
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(readFileSync(PAGE, "utf8").replace("__PORT__", String(port)));
    return;
  }
  if (req.method === "POST" && req.url === "/token") {
    const s = readState();
    const reader = readSecrets().reader;
    if (!s.kbId || !s.zone || !reader) return json(res, 409, { error: "Run the m0.ts kb and keys steps first." });
    const started = performance.now();
    const r = await fetch(`${zoneApi(s.zone)}/service_account_temporal_key`, {
      method: "POST",
      headers: { "X-NUCLIA-SERVICEACCOUNT": `Bearer ${reader}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: 10 }),
    });
    const body = (await r.json().catch(() => ({}))) as { token?: string };
    if (!r.ok || !body.token) return json(res, 502, { error: `Temporal key mint failed: ${r.status}` });
    return json(res, 200, {
      token: body.token,
      askUrl: `${zoneApi(s.zone)}/kb/${s.kbId}/ask`,
      searchConfig: s.searchConfig ?? null,
      mintMs: Math.round(performance.now() - started),
    });
  }
  res.writeHead(404).end();
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

for (const port of [4173, 4174]) {
  createServer((req, res) => handle(req, res, port).catch((e) => json(res, 500, { error: String(e) }))).listen(port, "localhost", () =>
    console.log(`spike page on http://localhost:${port}${port === 4173 ? " (allowed origin)" : " (not allowed)"}`),
  );
}
