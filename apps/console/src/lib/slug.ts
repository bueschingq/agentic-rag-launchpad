// Slugs for customers and Knowledge Boxes. KB slugs are unique across the partner's whole
// Agentic RAG account and must match [a-z0-9_-]. Pure, so it runs under node:test.

const MAX = 60;

export function slugify(text: string, max = MAX): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");
}

// <customer>-<site host without www>, e.g. "harbor-view-dental-harborviewdental-com".
export function kbSlugFor(customerSlug: string, siteUrl: string): string {
  const host = new URL(siteUrl).hostname.replace(/^www\./, "");
  return slugify(`${customerSlug}-${host}`) || "deployment";
}

// base, base-2, base-3, … trimmed so the suffix still fits.
export function uniqueSlug(base: string, taken: ReadonlySet<string>, max = MAX): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, max - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}
