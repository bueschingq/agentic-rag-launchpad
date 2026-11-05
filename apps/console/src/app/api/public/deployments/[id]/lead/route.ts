// POST: a lead from the chat's contact form (JSON). Only from the deployment's own domains,
// rate-limited, and only when the deployment's widget has the form turned on. Delivered as
// schemaVersion 2, with the consent, the trigger and the visit's attribution (lib/leads.ts). One
// from a staging domain or localhost is marked as a test.

import { languageSetting } from "@launchpad/theme";
import { isStagingOrigin } from "@/lib/domain-rules.ts";
import { acceptLead, parseLead } from "@/lib/leads.ts";
import { clientIp, corsHeaders, findDeployment, isAllowedOrigin, json, RateLimiter } from "@/lib/public-api.ts";

type Params = { params: Promise<{ id: string }> };

// A person fills in a contact form once; this stops scripts filling the client's inbox.
const limiter = new RateLimiter(5, 10 * 60_000);

export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const origin = request.headers.get("origin");
  const row = await findDeployment(id);
  if (!row) return json({ error: "Not found" }, 404);
  if (!isAllowedOrigin(origin, row.deployment.domains)) return json({ error: "Origin not allowed" }, 403);
  const cors = corsHeaders(origin);
  if (!limiter.allow(`${id}:${clientIp(request.headers)}`)) return json({ error: "Too many requests. Try again later." }, 429, cors);

  const text = (await request.text()).slice(0, 100_000);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "Send the form as JSON." }, 400, cors);
  }
  const parsed = parseLead(body, { settings: row.deployment.widgetSettings, language: languageSetting(row.deployment.language) });
  if ("error" in parsed) return json({ error: parsed.error }, 400, cors);
  await acceptLead(id, parsed.value, { test: isStagingOrigin(origin, row.deployment.stagingDomains) });
  return json({ ok: true }, 202, cors);
}

export async function OPTIONS(request: Request, { params }: Params) {
  const { id } = await params;
  const origin = request.headers.get("origin");
  const row = await findDeployment(id);
  if (!row || !isAllowedOrigin(origin, row.deployment.domains)) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}
