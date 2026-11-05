// A deployment's widget: scan the customer's site for its look, apply what fits, adjust the
// theme, text, handoff, contact form, buttons, privacy and analytics against a live preview,
// save, and confirm the brand at its real size.

import { confirmedTable, languageSetting } from "@launchpad/theme";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { intentRouting } from "@/app/api/public/deployments/[id]/config/intents.ts";
import { contactKeyPage, pagePaths, supportKeyPage } from "@/app/api/public/deployments/[id]/config/pages.ts";
import { currentUser } from "@/lib/auth.ts";
import { publicBaseUrl } from "@/lib/env.ts";
import { languageLabel } from "@/lib/labels.ts";
import { contentLanguages } from "@/lib/validation.ts";
import { confirmedOf, loadWidgetPage } from "@/lib/widget.ts";
import { draftFor } from "@/lib/widget-form.ts";
import { confirmBrand, runScan, saveWidgetSettings } from "./actions.ts";
import { fitSavedButtons, loadButtonSuggestions } from "./button-suggestions-load.ts";
import { WidgetConfigurator } from "./configurator.tsx";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; deploymentId: string }> };

// "Widget · Main site · Harbor View Dental", and the root layout adds "· Launchpad".
export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id, deploymentId } = await params;
  const page = await loadWidgetPage(id, deploymentId);
  return { title: page ? `Widget · ${page.deployment.name} · ${page.tenantName}` : "Widget" };
}

export default async function WidgetPage({ params }: Params) {
  const { id, deploymentId } = await params;
  const page = await loadWidgetPage(id, deploymentId);
  if (!page) notFound();
  const { deployment: d, scan, canAsk, suggestions } = page;
  const host = new URL(d.siteUrl).host;
  const language = languageSetting(d.language);
  const base = `/customers/${id}/deployments/${d.id}/widget`;
  const [user, buttons, routing, fitted] = await Promise.all([
    currentUser(),
    // Ready-made buttons from the key pages and the scan; none if they can't be read.
    loadButtonSuggestions({ ...d, language }, scan?.result.sources).catch(() => []),
    // The preview routes intent questions, links and price answers as the site's chat does.
    Promise.all([intentRouting(d).catch(() => ({})), pagePaths(d.id).catch(() => ({}))]).then(([intents, pages]) => {
      const priceTable = confirmedTable(d);
      return { ...intents, ...pages, ...(priceTable && { priceTable }) };
    }),
    // Saved buttons as each language's visitors get them.
    fitSavedButtons({ ...d, language }, d.widgetSettings).catch(() => ({ fits: [] })),
  ]);

  return (
    <main className="shell" id="main">
      <p className="crumbs">
        <Link href={`/customers/${id}/deployments/${d.id}`}>{d.name}</Link>
      </p>
      <div className="page-head">
        <h1>Widget</h1>
        <p className="muted">
          How the chat looks and behaves on {host}, in {language === "auto" ? "each visitor's language" : languageLabel(language)}. Saved
          changes reach the site within a minute, with no new embed code.
        </p>
      </div>
      <WidgetConfigurator
        deploymentId={d.id}
        siteUrl={d.siteUrl}
        language={language}
        saved={draftFor(d.theme, d.widgetSettings)}
        scan={scan}
        canAsk={canAsk}
        suggestions={suggestions}
        buttonSuggestions={buttons}
        buttonFits={fitted.fits}
        displayName={page.displayName}
        contactKeyPage={await contactKeyPage(d.id).catch(() => null)}
        supportKeyPage={await supportKeyPage(d.id).catch(() => null)}
        contentLanguages={await contentLanguages(d.id)}
        routing={routing}
        base={base}
        embedTag={`<arag-chat deployment="${d.id}" base-url="${publicBaseUrl()}"></arag-chat>`}
        scanAction={runScan.bind(null, id, d.id)}
        saveAction={saveWidgetSettings.bind(null, id, d.id)}
        confirmAction={confirmBrand.bind(null, id, d.id)}
        confirmed={confirmedOf({ theme: d.theme, settings: d.widgetSettings, confirmations: d.confirmations })}
        setupMode={user.setupMode}
        leadDestination={Boolean(d.leadDelivery.webhookUrl || d.leadDelivery.emails?.length)}
        leadsHref={`/customers/${id}/deployments/${d.id}/edit#leads`}
      />
    </main>
  );
}
