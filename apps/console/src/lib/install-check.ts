// "Check installation": the sniffer loads a page of the client's site and reports what it
// found (apps/sniffer/src/install.ts); these rules judge it for one deployment, in words the
// client's web team can act on. The rules are pure, so node:test covers them.
//
// One cause is one thing to fix: a policy that blocks the widget fails the CSP line, and the
// widget not showing because of it is a consequence, not a second fix. The policy is checked
// for the avatar too (img-src), since the scan's inline SVG logo needs data:.
//
// Nothing passes that the check didn't see. The page's actual render wins over our reading of
// its policy (nonces and 'strict-dynamic' trust what the page vouches for, not hosts), a domain
// passes only once Agentic RAG answers its preflight, and a page the chat stays off on purpose
// (an excluded path, Sitefinity's page editor) says so instead of failing.

import { zoneOrigin } from "@launchpad/par-client";
import { pathMatches } from "./content-plan.ts";
import { imageSource } from "./csp.ts";
import { twinOrigin } from "./domain-rules.ts";
import { snifferSettings } from "./sniffer.ts";

export interface InstallFacts {
  url: string;
  finalUrl: string;
  status: number;
  origin: string;
  csp: string[];
  // nonce: the tag carries one (older sniffers don't say).
  scripts: { src: string; deployment?: string; nonce?: boolean }[];
  // Inline scripts that load the widget (the guide's JavaScript form). Older sniffers don't report them.
  loaders?: { deployment?: string; nonce?: boolean }[];
  elements: { deployment?: string; baseUrl?: string; rendered: boolean; mode?: string }[];
  messages: string[];
  // For Sitefinity's page editor (the widget's own signals, apps/widget/src/page.ts).
  bodyClasses?: string[];
  framedWithContainers?: boolean;
  error?: string;
}

export interface InstallCheck {
  label: string;
  result: "pass" | "fail" | "warn";
  detail: string;
}

// Does a CSP source list allow this URL? Covers *, scheme sources, 'self' and host sources.
export function cspAllows(sources: readonly string[], url: string, pageOrigin: string): boolean {
  const target = new URL(url);
  return sources.some((raw) => {
    const s = raw.toLowerCase();
    if (s === "*") return /^https?:$/.test(target.protocol);
    if (s === "'self'") return target.origin === pageOrigin;
    if (/^[a-z][a-z0-9+.-]*:$/.test(s)) return target.protocol === s;
    if (s.startsWith("'")) return false;
    const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*\.)?([^/:]+)(?::(\d+|\*))?/.exec(s);
    if (!m) return false;
    const [, scheme, wildcard, host, port] = m;
    if (scheme && `${scheme}:` !== target.protocol) return false;
    if (!scheme && target.protocol !== "https:" && target.protocol !== "http:") return false;
    const hostOk = wildcard ? target.hostname.endsWith(`.${host}`) : target.hostname === host;
    const portOk = !port || port === "*" || port === (target.port || (target.protocol === "https:" ? "443" : "80"));
    return hostOk && portOk;
  });
}

// Each policy's directives; a missing fetch directive falls back to default-src.
function directives(policy: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const part of policy.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name && !map.has(name.toLowerCase())) map.set(name.toLowerCase(), sources);
  }
  return map;
}

// Script elements follow script-src-elem first, then script-src, then default-src.
const scriptSources = (d: Map<string, string[]>) => d.get("script-src-elem") ?? d.get("script-src") ?? d.get("default-src");

// The sources each policy lacks, as "directive source" (an image's source is its origin, or
// data: for an inline one).
export function missingCsp(
  policies: readonly string[],
  needs: { script: string[]; connect: string[]; image?: string[] },
  pageOrigin: string,
): string[] {
  const missing: string[] = [];
  for (const policy of policies) {
    const d = directives(policy);
    const check = (directive: string, sources: string[] | undefined, urls: string[]) => {
      if (!sources) return;
      for (const url of urls)
        if (!cspAllows(sources, url, pageOrigin)) missing.push(`${directive} ${imageSource(url) ?? new URL(url).origin}`);
    };
    check(d.has("script-src-elem") ? "script-src-elem" : "script-src", scriptSources(d), needs.script);
    check("connect-src", d.get("connect-src") ?? d.get("default-src"), needs.connect);
    check("img-src", d.get("img-src") ?? d.get("default-src"), needs.image ?? []);
  }
  return [...new Set(missing)];
}

// "connect-src a", "connect-src b" → "connect-src a b": a policy with two directives of the same
// name ignores the second, so the advice must be one line per directive.
export function cspAdvice(missing: readonly string[]): string {
  const byDirective = new Map<string, string[]>();
  for (const entry of missing) {
    const [directive, source] = entry.split(" ") as [string, string];
    byDirective.set(directive, [...(byDirective.get(directive) ?? []), source]);
  }
  return [...byDirective].map(([directive, sources]) => `${directive} ${sources.join(" ")}`).join("; ");
}

// Does every policy let an inline script run? A nonce or hash makes 'unsafe-inline' ignored; a
// script carrying the page's nonce runs under a nonce policy.
export function inlineScriptsAllowed(policies: readonly string[], nonced = false): boolean {
  return policies.every((policy) => {
    const sources = scriptSources(directives(policy))?.map((s) => s.toLowerCase());
    if (!sources) return true;
    if (nonced && sources.some((s) => s.startsWith("'nonce-"))) return true;
    const pinned = sources.some((s) => s.startsWith("'nonce-") || /^'sha(256|384|512)-/.test(s) || s === "'strict-dynamic'");
    return sources.includes("'unsafe-inline'") && !pinned;
  });
}

// Under 'strict-dynamic' a policy ignores the hosts it lists: a script runs only when the page
// vouches for it (its nonce), or when a vouched-for script added it.
export const strictDynamic = (policies: readonly string[]): boolean =>
  policies.some((policy) => scriptSources(directives(policy))?.some((s) => s.toLowerCase() === "'strict-dynamic'") ?? false);

// Sitefinity opens pages for editing at /Action/Edit or ?sfaction=edit, with editor classes on
// the body, or framed with data-sfcontainer elements (as the widget's own check).
export function sitefinityEditor(f: Pick<InstallFacts, "finalUrl" | "bodyClasses" | "framedWithContainers">): boolean {
  const u = new URL(f.finalUrl);
  if (/\/action\/edit(\/|$)/i.test(u.pathname) || u.searchParams.get("sfaction")?.toLowerCase() === "edit") return true;
  return (f.bodyClasses ?? []).some((c) => c === "sfPageEditor" || c === "sfTemplateEditor") || Boolean(f.framedWithContainers);
}

// The browser's own CSP complaints about the widget, its config or its questions.
const blockedByBrowser = (messages: readonly string[], consoleOrigin: string) =>
  messages.filter(
    (m) => /Content Security Policy|Refused to (load|connect)/i.test(m) && (m.includes("arag-chat") || m.includes(consoleOrigin)),
  );

export interface JudgedDeployment {
  id: string;
  domains: string[];
  consoleOrigin: string;
  zone: string;
  // Provisioned (it has a Knowledge Box), and signed off so the chat shows on sites.
  provisioned?: boolean;
  published?: boolean;
  // Who signs it off, for "The chat appears once … signs it off".
  partner?: string;
  // The chat's avatar (an https image or an inline SVG data: URL), which img-src must allow.
  avatar?: string;
  // Paths the chat stays off (widget settings' exclude).
  exclude?: string[];
  // Whether Agentic RAG answers a preflight from the page's origin yet (undefined: not checked).
  lockApplied?: boolean;
}

export function judgeInstall(facts: InstallFacts, d: JudgedDeployment): InstallCheck[] {
  const checks: InstallCheck[] = [];
  if (d.provisioned === false) {
    return [{ label: "Not ready yet", result: "fail", detail: "This chat hasn't been set up yet, so there's nothing to install." }];
  }
  if (facts.error || facts.status >= 400 || facts.status === 0) {
    return [
      {
        label: "Page loads",
        result: "fail",
        detail: facts.error ? `It didn't load: ${facts.error}` : `The site answered ${facts.status}.`,
      },
    ];
  }
  checks.push({ label: "Page loads", result: "pass", detail: `${facts.finalUrl} answered ${facts.status}.` });
  if (sitefinityEditor(facts)) {
    checks.push({
      label: "Widget shows",
      result: "warn",
      detail: "This is Sitefinity's page editor: the chat stays off here by design. Check a published page instead.",
    });
    return checks;
  }

  const ours = facts.scripts.filter((s) => s.deployment === d.id);
  const others = facts.scripts.filter((s) => s.deployment && s.deployment !== d.id);
  const element = facts.elements.find((e) => e.deployment === d.id);
  const loader = facts.loaders?.find((l) => l.deployment === d.id);
  const fileLink = `${d.consoleOrigin}/arag-chat.js?deployment=${d.id}`;
  if (ours.length || element) checks.push({ label: "Snippet", result: "pass", detail: "Found, for this deployment." });
  else if (loader)
    checks.push({
      label: "Snippet",
      result: "fail",
      detail: inlineScriptsAllowed(facts.csp, loader.nonce)
        ? "The JavaScript code is on the page, but it didn't run. See the browser's message below."
        : `The JavaScript code is on the page, but the site's CSP blocks inline scripts, so it never ran. In Sitefinity's JavaScript widget, choose "Link to a file" with ${fileLink} instead, or use the snippet in the layout.`,
    });
  else if (others.length)
    checks.push({
      label: "Snippet",
      result: "fail",
      detail: `Found, but for another deployment (${others[0]!.deployment}). Copy this deployment's snippet.`,
    });
  else if (facts.scripts.length)
    checks.push({
      label: "Snippet",
      result: "fail",
      detail: "The widget's script is there without data-deployment. Copy the snippet as it is.",
    });
  else
    checks.push({
      label: "Snippet",
      result: "fail",
      detail: "Not on this page. Add it before </body>, in the layout template or a tag manager.",
    });

  const src = ours[0]?.src ?? facts.scripts[0]?.src;
  if (src && new URL(src).origin !== d.consoleOrigin) {
    checks.push({
      label: "Script address",
      result: "fail",
      detail: `The script loads from ${new URL(src).origin}, not ${d.consoleOrigin}.`,
    });
  }

  if (d.domains.includes(facts.origin)) {
    checks.push(
      d.lockApplied === false
        ? {
            // Allow it, or a domain just added: the console lets it in, Agentic RAG hasn't yet.
            label: "Domain allowed",
            result: "warn",
            detail: `${facts.origin} is added. Agentic RAG is still applying it (usually 1 to 3 minutes), so questions from this page fail until then. Check again shortly.`,
          }
        : { label: "Domain allowed", result: "pass", detail: `${facts.origin} is allowed.` },
    );
  } else {
    const twin = twinOrigin(facts.origin);
    const hint =
      twin && d.domains.includes(twin)
        ? ` Only ${twin} is allowed: add ${facts.origin} too, on the deployment's Edit page.`
        : " Add it on the deployment's Edit page.";
    checks.push({
      label: "Domain allowed",
      result: "fail",
      detail: `${facts.origin} isn't allowed, so the widget won't load there.${hint}`,
    });
  }

  const rendered = facts.elements.some((e) => e.rendered && (!e.deployment || e.deployment === d.id));
  // Whether the site's policy keeps the widget from running at all (rather than only its logo).
  let cspBlocks = false;
  if (facts.csp.length) {
    // Under 'strict-dynamic' the script runs if the page vouches for it, whatever hosts are listed.
    const strict = strictDynamic(facts.csp);
    const vouched = ours.some((s) => s.nonce) || Boolean(loader?.nonce);
    const found = missingCsp(
      facts.csp,
      {
        script: strict ? [] : [`${d.consoleOrigin}/arag-chat.js`],
        connect: [`${d.consoleOrigin}/api/public/`, `${zoneOrigin(d.zone)}/api/v1/`],
        image: d.avatar && imageSource(d.avatar) ? [d.avatar] : [],
      },
      facts.origin,
    );
    // The render wins: a chat that drew itself loaded its script and its config, whatever our
    // reading of the policy says. Its questions (the zone) and its logo still need their sources.
    const missing = rendered ? found.filter((m) => !m.startsWith("script-src") && m !== `connect-src ${d.consoleOrigin}`) : found;
    const strictBlocked = strict && !vouched && !rendered;
    const browser = rendered ? [] : blockedByBrowser(facts.messages, d.consoleOrigin);
    const logoOnly = missing.length > 0 && missing.every((m) => m.startsWith("img-src "));
    const inlineBlocked = Boolean(loader) && !rendered && !inlineScriptsAllowed(facts.csp, loader?.nonce);
    cspBlocks = (missing.length > 0 && !logoOnly) || inlineBlocked || strictBlocked || browser.length > 0;
    checks.push(
      strictBlocked
        ? {
            label: "Content Security Policy",
            result: "fail",
            detail:
              "The site's CSP uses 'strict-dynamic', so the hosts it lists don't count: a script runs only if the page vouches for it. Give the snippet's <script> tag the page's nonce (nonce=\"…\", the same value as the site's other scripts), or add the JavaScript code to a script that has it.",
          }
        : logoOnly
          ? {
              label: "Content Security Policy",
              result: "fail",
              detail: `The chat works, but the site's CSP blocks its logo. Add this source to the existing directives: ${cspAdvice(missing)}.`,
            }
          : missing.length
            ? {
                label: "Content Security Policy",
                result: "fail",
                detail: `The site's CSP blocks the widget. Add these sources to the existing directives: ${cspAdvice(missing)}.`,
              }
            : inlineBlocked
              ? {
                  // The Snippet line above says what to do instead: one fix, counted there.
                  label: "Content Security Policy",
                  result: "warn",
                  detail:
                    "The site's CSP allows the widget's script, but not inline scripts, which the JavaScript code on this page is (see Snippet).",
                }
              : browser.length
                ? {
                    // Our reading found nothing, but the browser blocked it: the browser is right.
                    label: "Content Security Policy",
                    result: "fail",
                    detail: `The browser blocked the widget under the site's CSP: ${browser.slice(0, 2).join(" / ")}`,
                  }
                : {
                    label: "Content Security Policy",
                    result: "pass",
                    detail: rendered
                      ? "The site sends a CSP, and the chat rendered under it."
                      : "The site sends a CSP, and it allows the widget.",
                  },
    );
  } else checks.push({ label: "Content Security Policy", result: "pass", detail: "The site sends none, so nothing blocks the widget." });

  // Installed early, while the partner finishes: the chat stays hidden until sign-off.
  const waiting = d.published === false && (ours.length > 0 || element !== undefined) && d.domains.includes(facts.origin);
  // A page the chat stays off on purpose: not a failure.
  const path = new URL(facts.finalUrl).pathname;
  const excludedBy = d.exclude?.find((pattern) => pathMatches(facts.finalUrl, [pattern], path));
  checks.push(
    excludedBy && !rendered
      ? {
          label: "Widget shows",
          result: "warn",
          detail: `Left out on purpose by ${excludedBy}: the chat stays off this page. Check another page.`,
        }
      : waiting
        ? {
            label: "Widget shows",
            result: "warn",
            detail: `Snippet found. The chat appears once ${d.partner || "your agency"} signs it off, with nothing to change on the page.`,
          }
        : rendered
          ? { label: "Widget shows", result: "pass", detail: "The chat rendered on the page." }
          : cspBlocks
            ? {
                // The policy above is the one thing to fix.
                label: "Widget shows",
                result: "warn",
                detail: "Not yet: the Content Security Policy above keeps it from loading. It shows once that's fixed.",
              }
            : {
                label: "Widget shows",
                result: "fail",
                detail: facts.messages.length
                  ? `It didn't render. The browser said: ${facts.messages.slice(0, 2).join(" / ")}`
                  : "It didn't render within 8 seconds.",
              },
  );
  return checks;
}

// The check found this deployment's snippet on one of its allowed domains: what the stage counts
// as the snippet being in place (lib/onboarding.ts), before any visitor chats.
export const snippetInPlace = (checks: readonly InstallCheck[], origin: string | undefined, domains: readonly string[]): boolean =>
  Boolean(origin && domains.includes(origin)) && checks.some((c) => c.label === "Snippet" && c.result === "pass");

export async function runInstallCheck(url: string): Promise<InstallFacts | { error: string }> {
  const sniffer = snifferSettings();
  if (!sniffer) return { error: "The site scanner isn't set up, so installations can't be checked." };
  try {
    const res = await fetch(`${sniffer.url}/check`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-sniffer-token": sniffer.token },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = (await res.json()) as InstallFacts & { error?: string };
    if (!res.ok) return { error: body.error ?? `The scanner answered ${res.status}.` };
    return body;
  } catch {
    return { error: "The site scanner isn't reachable right now." };
  }
}
