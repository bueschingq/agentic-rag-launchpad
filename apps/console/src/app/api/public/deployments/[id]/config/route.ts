// GET: the widget's runtime config (theme, copy, KB). Nothing secret, but only served
// cross-origin to the deployment's own domains, and only once a person has signed the chat off:
// before that it answers { published: false } and the widget shows nothing.

import {
  configStrings,
  confirmedTable,
  defaultWidgetSettings,
  languageSetting,
  type PublicWidgetConfig,
  resolveTheme,
} from "@launchpad/theme";
import { fitSavedButtons } from "@/app/customers/[id]/deployments/[deploymentId]/widget/button-suggestions-load.ts";
import { searchConfigName } from "@/lib/prompt.ts";
import { corsHeaders, findDeployment, isAllowedOrigin, isOnline, json, recordRefused } from "@/lib/public-api.ts";
import { contentLanguages } from "@/lib/validation.ts";
import { provisionalTable } from "@/lib/validation-rules.ts";
import { intentRouting } from "./intents.ts";
import { pagePaths } from "./pages.ts";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  const { id } = await params;
  const origin = request.headers.get("origin");
  const row = await findDeployment(id);
  const kbId = row?.deployment.kbId;
  // Refusals are readable cross-origin, so the widget can tell the site owner which it was.
  const readable = origin ? corsHeaders(origin) : {};
  if (!row || !kbId) return json({ error: "Not found" }, 404, readable);

  const { deployment } = row;
  // No Origin header means a direct request (curl, server-side); browsers always send one cross-origin.
  if (origin !== null && !isAllowedOrigin(origin, deployment.domains)) {
    await recordRefused(deployment.id, origin);
    return json({ error: "Origin not allowed" }, 403, readable);
  }

  if (!deployment.published) {
    return json({ published: false }, 200, { "Cache-Control": "public, max-age=60", ...readable });
  }

  const { offlineMessage, ...saved } = deployment.widgetSettings;
  // Each language's buttons open its own language's pages, or don't show (round 6, teamleader.eu).
  const { settings } = await fitSavedButtons({ ...deployment, language: languageSetting(deployment.language) }, saved).catch(() => ({
    settings: saved,
  }));
  const priceTable = confirmedTable(deployment);
  const pricingFacts = priceTable ? undefined : provisionalTable(deployment.priceTable?.rows ?? []);
  const config: PublicWidgetConfig = {
    deploymentId: deployment.id,
    zone: deployment.zone,
    kbId,
    // Empty: the KB's own defaults (see searchConfigName).
    searchConfig: searchConfigName(deployment) ?? "",
    theme: resolveTheme(deployment.theme).theme,
    // Copy left unset comes from the widget, in the visitor's language when this is "auto".
    settings: { ...defaultWidgetSettings, ...settings, language: languageSetting(deployment.language) },
    // Off while paused (deployment or customer) or stopped for the customer's budget.
    online: await isOnline(row),
    offlineMessage,
    // The widget's own text in the languages this chat can use; English is in the bundle.
    strings: configStrings(languageSetting(deployment.language), settings.languages ?? []),
    // So the widget asks in the question's language where the KB holds several.
    contentLanguages: await contentLanguages(deployment.id),
    // So it asks an intent question with its intent's configuration and pages first.
    ...(await intentRouting(deployment)),
    // So each ask's own filter keeps the agents' generated text out, as the saved configurations do.
    ...(deployment.augmentation && { excludeGenerated: true as const }),
    // So a price answer that contradicts the confirmed table is replaced with its rows; only while
    // the confirmation holds for these rows.
    ...(priceTable && { priceTable }),
    // So a reply denying a price the pricing page states gets the handoff card, while none is confirmed.
    ...(pricingFacts && { pricingFacts }),
    // So a model-written link opens only a synced page (renderModelText).
    ...(await pagePaths(deployment.id).catch(() => ({}))),
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
