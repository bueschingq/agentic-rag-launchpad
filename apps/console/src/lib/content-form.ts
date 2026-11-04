// Validation for a deployment's content settings. Pure, so it runs under node:test.

import { isPlanRule, isSitemapAddress, type PlanRule } from "./content-plan.ts";
import type { FormErrors } from "./customer-form.ts";

export const DEFAULT_PAGE_BUDGET = 200;
export const MAX_PAGE_BUDGET = 5000;
// Pages a chatbot should never answer from: search results, sign-in and checkout flows, the
// CMS's own backend (Sitefinity serves it under /Sitefinity), and print views.
export const DEFAULT_EXCLUDES = ["/search", "/login", "/logout", "/account", "/cart", "/checkout", "/sitefinity", "*/print"];

export const SITEFINITY_VERSIONS = ["unknown", "15.4+", "earlier", "none"] as const;
export type SitefinityVersion = (typeof SITEFINITY_VERSIONS)[number];

export const RESYNC_OPTIONS = { "24": "Daily", "168": "Weekly", off: "Only when I ask" } as const;

export interface ContentSettings {
  // How content gets in: sitemap sync, or Sitefinity's own connector (15.4 and later).
  path: "sitemap" | "sitefinity_connector";
  sitefinityVersion: SitefinityVersion;
  // Where page discovery starts: the site, or a section of it. Sitemaps are found from it.
  startUrl: string;
  // A sitemap file to read instead of finding one (robots.txt pointing at another site's).
  sitemap?: string;
  pageBudget: number;
  include: string[];
  exclude: string[];
  resyncHours: number | null;
}

const PATTERN = /^[/*][^\s]{0,200}$/;

export function parsePatterns(raw: string): { patterns: string[]; bad?: string } {
  const patterns = [
    ...new Set(
      raw
        .split(/[\n,]+/)
        .map((p) => p.trim())
        .filter(Boolean),
    ),
  ];
  const bad = patterns.find((p) => !PATTERN.test(p));
  return bad ? { patterns, bad } : { patterns: patterns.slice(0, 50) };
}

// The content plan's part of New deployment: what the partner kept of the plan as shown.
export interface PlanFormValue {
  pageBudget: number;
  include: string[];
  exclude: string[];
  // Language groups as the plan lists them ("en", "zh-tw", "und"); empty: every language.
  languages: string[];
  rules: PlanRule[];
  sitefinityVersion: SitefinityVersion;
  // The scan started when the site address was entered, saved once the deployment exists.
  scanToken?: string;
  // A sitemap file to read instead of finding one.
  sitemap?: string;
}

// A sitemap address as entered: a web address ending in .xml or .gz (a gzipped sitemap), on any host (a sitemap can list a
// site's pages from elsewhere; only the site's own are taken).
export function parseSitemapAddress(raw: string): { sitemap?: string; error?: string } {
  const value = raw.trim();
  if (!value) return {};
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    if (/^https?:$/.test(url.protocol) && isSitemapAddress(url.href)) return { sitemap: url.href };
  } catch {
    // not an address
  }
  return {
    error: "Enter the sitemap file's address, ending in .xml or .gz, e.g. https://www.example.com/sitemap.xml or …/sitemap.xml.gz.",
  };
}

const LANGUAGE_TAG = /^(und|[a-z]{2,3}(-[a-z0-9]{2,8})*)$/;
const TOKEN = /^[0-9a-f-]{36}$/;

export function parsePlanForm(form: FormData): { value: PlanFormValue } | { errors: FormErrors } {
  const text = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value.trim() : "";
  };
  const all = (name: string) => form.getAll(name).filter((v): v is string => typeof v === "string");
  const errors: FormErrors = {};

  const budget = Number(text("pageBudget") || DEFAULT_PAGE_BUDGET);
  if (!Number.isInteger(budget) || budget < 1 || budget > MAX_PAGE_BUDGET) {
    errors.pageBudget = `Choose a whole number of pages from 1 to ${MAX_PAGE_BUDGET.toLocaleString("en")}.`;
  }
  const include = parsePatterns(text("include"));
  if (include.bad) errors.include = `"${include.bad}" isn't a path: start each with / (or * for any).`;
  // A form without the plan (the sitemap couldn't be read) keeps the default exclusions.
  const exclude = form.has("exclude") ? parsePatterns(text("exclude")) : { patterns: DEFAULT_EXCLUDES };
  if (exclude.bad) errors.exclude = `"${exclude.bad}" isn't a path: start each with / (or * for any).`;
  const languages = [...new Set(all("languages").map((l) => l.toLowerCase()))].filter((l) => LANGUAGE_TAG.test(l)).slice(0, 40);
  // Only when the plan showed its languages to choose from: no error names a control that isn't
  // on the page (a sitemap with no pages lists none, and the sync keeps the deployment's own).
  if (form.has("languagesShown") && languages.length === 0) errors.languages = "Keep at least one language.";
  const sitemap = parseSitemapAddress(text("sitemap"));
  if (sitemap.error) errors.sitemap = sitemap.error;
  const rules = [...new Set(all("rules"))].filter(isPlanRule);
  const version = (SITEFINITY_VERSIONS as readonly string[]).includes(text("sitefinityVersion"))
    ? (text("sitefinityVersion") as SitefinityVersion)
    : "unknown";
  const scanToken = TOKEN.test(text("scanToken")) ? text("scanToken") : undefined;

  if (Object.keys(errors).length) return { errors };
  return {
    value: {
      pageBudget: budget,
      include: include.patterns,
      exclude: exclude.patterns,
      languages,
      rules,
      sitefinityVersion: version,
      ...(scanToken && { scanToken }),
      ...(sitemap.sitemap && { sitemap: sitemap.sitemap }),
    },
  };
}

// The site address as New deployment reads it: a bare host is taken to be on https.
export function siteAddress(raw: string): string | undefined {
  const value = raw.trim();
  for (const candidate of value.includes("://") ? [value] : [`https://${value}`]) {
    try {
      const url = new URL(candidate);
      if (/^https?:$/.test(url.protocol) && (url.hostname.includes(".") || url.hostname === "localhost")) return url.href;
    } catch {
      // not an address
    }
  }
  return undefined;
}

// What the scan's platform detection suggests for the version question: Sitefinity's generator
// tag carries the version when it isn't stripped.
export function versionFromScan(platform: { platform: string; version?: string } | undefined): SitefinityVersion {
  if (!platform || platform.platform === "unknown") return "unknown";
  if (platform.platform !== "sitefinity") return "none";
  const [major = 0, minor = 0] = (platform.version ?? "").split(".").map(Number);
  if (!platform.version) return "unknown";
  return major > 15 || (major === 15 && minor >= 4) ? "15.4+" : "earlier";
}

export function parseContentForm(form: FormData, siteUrl: string): { value: ContentSettings } | { errors: FormErrors } {
  const text = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value.trim() : "";
  };
  const errors: FormErrors = {};

  const version = (SITEFINITY_VERSIONS as readonly string[]).includes(text("sitefinityVersion"))
    ? (text("sitefinityVersion") as SitefinityVersion)
    : "unknown";
  const path = text("path") === "sitefinity_connector" ? "sitefinity_connector" : "sitemap";

  // Discovery stays on the deployment's own site.
  let startUrl = siteUrl;
  const rawStart = text("startUrl");
  if (rawStart) {
    try {
      const url = new URL(rawStart.includes("://") ? rawStart : `https://${rawStart}`);
      const bare = (h: string) => h.replace(/^www\./, "");
      if (!/^https?:$/.test(url.protocol) || bare(url.hostname) !== bare(new URL(siteUrl).hostname)) {
        errors.startUrl = `Start from a page on ${new URL(siteUrl).hostname}.`;
      } else startUrl = url.href;
    } catch {
      errors.startUrl = "Enter a web address, e.g. https://www.example.com/en/.";
    }
  }

  const budget = Number(text("pageBudget") || DEFAULT_PAGE_BUDGET);
  if (!Number.isInteger(budget) || budget < 1 || budget > MAX_PAGE_BUDGET) {
    errors.pageBudget = `Choose a whole number of pages from 1 to ${MAX_PAGE_BUDGET.toLocaleString("en")}.`;
  }

  const include = parsePatterns(text("include"));
  if (include.bad) errors.include = `"${include.bad}" isn't a path: start each with / (or * for any).`;
  const exclude = parsePatterns(text("exclude"));
  if (exclude.bad) errors.exclude = `"${exclude.bad}" isn't a path: start each with / (or * for any).`;

  const resync = text("resync");
  const resyncHours = resync === "off" ? null : resync === "168" ? 168 : 24;
  const sitemap = parseSitemapAddress(text("sitemap"));
  if (sitemap.error) errors.sitemap = sitemap.error;

  if (Object.keys(errors).length) return { errors };
  return {
    value: {
      path,
      sitefinityVersion: version,
      startUrl,
      ...(sitemap.sitemap && { sitemap: sitemap.sitemap }),
      pageBudget: budget,
      include: include.patterns,
      exclude: exclude.patterns,
      resyncHours,
    },
  };
}
