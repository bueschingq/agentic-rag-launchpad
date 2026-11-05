// What the widget page's button suggestions are made from (button-suggestions.ts): the
// deployment's key pages and the trial, demo and quote links its pages carry (content_pages.facts),
// kept to the site and to the deployment's own paths. Also the saved buttons fitted to each served
// language, as the public config serves them. Server only.

import { contentPages, syncSources } from "@launchpad/db";
import type { Language, LanguageSetting, WidgetSettings } from "@launchpad/theme";
import { and, eq, isNotNull, ne, or, sql } from "drizzle-orm";
import { pathLanguage, withinRules } from "@/lib/content-plan.ts";
import { db } from "@/lib/db.ts";
import {
  type ButtonFit,
  type ButtonPage,
  type ButtonSuggestion,
  buttonPages,
  fitCtasToLanguages,
  type PageRow,
  scanButtonLabel,
  suggestButtons,
} from "./button-suggestions.ts";

type Deployment = { id: string; siteUrl: string; language: LanguageSetting; widgetSettings: WidgetSettings };

async function loadButtonPages(d: Pick<Deployment, "id" | "siteUrl">): Promise<ButtonPage[]> {
  const [rows, [source]] = await Promise.all([
    db()
      .select({
        url: contentPages.url,
        lang: contentPages.lang,
        keyIntent: contentPages.keyIntent,
        status: contentPages.status,
        detail: contentPages.detail,
        facts: contentPages.facts,
      })
      .from(contentPages)
      .where(
        and(
          eq(contentPages.deploymentId, d.id),
          ne(contentPages.status, "removed"),
          or(isNotNull(contentPages.keyIntent), sql`jsonb_array_length(coalesce(${contentPages.facts}->'links', '[]'::jsonb)) > 0`),
        ),
      ),
    db()
      .select({ include: syncSources.includePatterns, exclude: syncSources.excludePatterns })
      .from(syncSources)
      .where(and(eq(syncSources.deploymentId, d.id), eq(syncSources.kind, "sitemap"))),
  ]);
  const include = source?.include ?? [];
  const exclude = source?.exclude ?? [];
  return buttonPages(rows as PageRow[], d.siteUrl, (url) => withinRules(url, include, exclude), pathLanguage);
}

// The deployment's main language and the languages it serves.
function languagesOf(
  d: Pick<Deployment, "language" | "widgetSettings">,
  settings = d.widgetSettings,
): { main: Language; served: Language[] } {
  const served: Language[] = d.language === "auto" ? (settings.languages?.length ? settings.languages : ["en"]) : [d.language];
  return { main: served[0]!, served };
}

export async function loadButtonSuggestions(d: Deployment, scanSources: Record<string, string> | undefined): Promise<ButtonSuggestion[]> {
  const pages = await loadButtonPages(d);
  return suggestButtons({
    pages,
    main: languagesOf(d).main,
    existing: d.widgetSettings.ctas ?? [],
    scanButton: scanButtonLabel(scanSources),
  });
}

// Saved buttons as each language's visitors get them (fitCtasToLanguages): for the public config,
// and for the widget page to say what changed. Single-language deployments are served as saved.
export async function fitSavedButtons<S extends WidgetSettings>(d: Deployment, settings: S): Promise<{ settings: S; fits: ButtonFit[] }> {
  const { main, served } = languagesOf(d, settings);
  if (served.length < 2 || !settings.ctas?.length) return { settings, fits: [] };
  return fitCtasToLanguages(settings, await loadButtonPages(d), main, served, pathLanguage);
}
