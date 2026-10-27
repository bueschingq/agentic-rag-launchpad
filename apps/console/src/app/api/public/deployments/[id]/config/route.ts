// GET: the widget's runtime config (theme, copy, KB). Nothing secret, but only served
// cross-origin to the deployment's own domains.

import { defaultWidgetSettings, type PublicWidgetConfig, resolveTheme } from "@launchpad/theme";
import { corsHeaders, findDeployment, isAllowedOrigin, json } from "@/lib/public-api.ts";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  const { id } = await params;
  const origin = request.headers.get("origin");
  const row = await findDeployment(id);
  const kbId = row?.deployment.kbId;
  if (!row || !kbId) return json({ error: "Not found" }, 404);

  const { deployment } = row;
  // No Origin header means a direct request (curl, server-side); browsers always send one cross-origin.
  if (origin !== null && !isAllowedOrigin(origin, deployment.domains)) return json({ error: "Origin not allowed" }, 403);

  const { offlineMessage, ...settings } = deployment.widgetSettings;
  const config: PublicWidgetConfig = {
    deploymentId: deployment.id,
    zone: deployment.zone,
    kbId,
    searchConfig: deployment.searchConfig,
    theme: resolveTheme(deployment.theme).theme,
    settings: { ...defaultWidgetSettings, ...settings },
    online: deployment.status === "live" && row.tenantStatus === "active",
    offlineMessage: offlineMessage ?? "Chat is unavailable right now.",
  };
  return json(config, 200, {
    "Cache-Control": "public, max-age=60",
    ...(origin ? corsHeaders(origin) : {}),
  });
}

export async function OPTIONS(request: Request, { params }: Params) {
  const { id } = await params;
  const origin = request.headers.get("origin");
  const row = await findDeployment(id);
  if (!row || !isAllowedOrigin(origin, row.deployment.domains)) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}
