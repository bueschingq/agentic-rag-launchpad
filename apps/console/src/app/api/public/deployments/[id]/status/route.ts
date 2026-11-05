// GET: whether the chat may answer right now. The widget checks it before a question when its
// last check is over 30 seconds old, so Pause (or the budget stop) ends open conversations within
// a minute instead of when their 15-minute token runs out.

import { corsHeaders, findDeployment, isAllowedOrigin, isOnline, json } from "@/lib/public-api.ts";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  const { id } = await params;
  const origin = request.headers.get("origin");
  const row = await findDeployment(id);
  if (!row?.deployment.kbId) return json({ error: "Not found" }, 404, origin ? corsHeaders(origin) : {});
  if (origin !== null && !isAllowedOrigin(origin, row.deployment.domains))
    return json({ error: "Origin not allowed" }, 403, corsHeaders(origin));
  const online = row.deployment.published && (await isOnline(row));
  return json({ online }, 200, { "Cache-Control": "public, max-age=15", ...(origin ? corsHeaders(origin) : {}) });
}

export async function OPTIONS(request: Request, { params }: Params) {
  const { id } = await params;
  const origin = request.headers.get("origin");
  const row = await findDeployment(id);
  if (!row || !isAllowedOrigin(origin, row.deployment.domains)) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}
