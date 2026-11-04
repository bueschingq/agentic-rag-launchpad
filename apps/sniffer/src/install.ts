// Facts about a page that should carry the chat widget, for the console's "Check installation":
// the page's Content Security Policy, the widget's script tags and elements, whether the widget
// rendered, and what it logged. The console judges them (it knows the deployment); this only
// looks, in the same guarded browser as every scan.

import { guardedContext } from "./scan.ts";

export interface InstallFacts {
  url: string;
  finalUrl: string;
  status: number;
  origin: string;
  // From the response header and any <meta http-equiv>, as written.
  csp: string[];
  // nonce: the tag carries one, which a 'strict-dynamic' or nonce policy needs (the browser hides
  // its value, so only that it has one).
  scripts: { src: string; deployment?: string; nonce?: boolean }[];
  // Inline scripts that load the widget (the guide's JavaScript form).
  loaders: { deployment?: string; nonce?: boolean }[];
  elements: { deployment?: string; baseUrl?: string; rendered: boolean; mode?: string }[];
  // The widget's own console messages ("[arag-chat] …"), and CSP violations the page reported.
  messages: string[];
  // For Sitefinity's page editor, where the chat stays off by design.
  bodyClasses?: string[];
  framedWithContainers?: boolean;
  error?: string;
}

export async function checkInstall(url: string, opts: { waitMs?: number } = {}): Promise<InstallFacts> {
  const context = await guardedContext();
  const page = await context.newPage();
  const messages: string[] = [];
  page.on("console", (m) => {
    const text = m.text();
    if (/arag-chat|Content Security Policy|Refused to (load|connect|apply)/i.test(text)) messages.push(text.slice(0, 400));
  });
  try {
    const res = await page.goto(url, { waitUntil: "load", timeout: 20_000 });
    // The widget loads async and then fetches its config: give it a moment to render.
    await page
      .waitForFunction(
        () => Array.from(document.querySelectorAll("arag-chat")).some((el) => (el.shadowRoot?.childElementCount ?? 0) > 1),
        null,
        {
          timeout: opts.waitMs ?? 8_000,
        },
      )
      .catch(() => {});
    const header = res?.headers()["content-security-policy"];
    const facts = await page.evaluate(() => ({
      meta: Array.from(document.querySelectorAll<HTMLMetaElement>('meta[http-equiv="Content-Security-Policy" i]')).map((m) => m.content),
      scripts: Array.from(document.querySelectorAll<HTMLScriptElement>("script[src]"))
        .filter((s) => /arag-chat(\.min)?\.js/.test(s.src))
        .map((s) => {
          const deployment = s.dataset.deployment ?? new URL(s.src).searchParams.get("deployment");
          return { src: s.src, ...(deployment && { deployment }), ...(s.nonce && { nonce: true }) };
        }),
      // The JavaScript form of the snippet, written into the page (Sitefinity's JavaScript
      // widget, a tag manager). It only shows up as a script[src] once it has run.
      loaders: Array.from(document.querySelectorAll<HTMLScriptElement>("script:not([src])"))
        .filter((s) => (s.textContent ?? "").includes("arag-chat"))
        .map((s) => {
          const deployment = /data-deployment["']\s*,\s*["']([^"']+)/.exec(s.textContent ?? "")?.[1];
          return { ...(deployment && { deployment }), ...(s.nonce && { nonce: true }) };
        }),
      bodyClasses: document.body ? [...document.body.classList] : [],
      framedWithContainers: window.top !== window && document.querySelector("[data-sfcontainer]") !== null,
      elements: Array.from(document.querySelectorAll("arag-chat")).map((el) => ({
        ...(el.getAttribute("deployment") && { deployment: el.getAttribute("deployment")! }),
        ...(el.getAttribute("base-url") && { baseUrl: el.getAttribute("base-url")! }),
        rendered: (el.shadowRoot?.childElementCount ?? 0) > 1,
        ...((el as HTMLElement).dataset.mode && { mode: (el as HTMLElement).dataset.mode }),
      })),
    }));
    return {
      url,
      finalUrl: page.url(),
      status: res?.status() ?? 0,
      origin: new URL(page.url()).origin,
      csp: [...(header ? [header] : []), ...facts.meta],
      scripts: facts.scripts,
      loaders: facts.loaders,
      elements: facts.elements,
      messages,
      bodyClasses: facts.bodyClasses,
      framedWithContainers: facts.framedWithContainers,
    };
  } catch (err) {
    return {
      url,
      finalUrl: url,
      status: 0,
      origin: new URL(url).origin,
      csp: [],
      scripts: [],
      loaders: [],
      elements: [],
      messages,
      error: err instanceof Error ? err.message.split("\n")[0]! : String(err),
    };
  } finally {
    await context.close();
  }
}
