// Bot protection: a site whose firewall answers the sniffer with a challenge, a block page or a
// cookie wall instead of robots.txt, a sitemap or the start page (round 6: pella.com waited 93 s
// for the plan, then crawled nothing). The plan says so within seconds, before a Knowledge Box is
// spent, so the partner can ask the client's web team to allow the crawler.

export interface Blocked {
  // The file or page that came back blocked.
  url: string;
  status: number;
  // Who blocked it, as far as the response says ("Cloudflare", "Akamai"), or "bot protection".
  by: string;
}

interface Answer {
  status: number;
  headers: Record<string, string>;
  text: string;
}

const header = (a: Answer, name: string) => a.headers[name] ?? "";
const title = (text: string) => /<title[^>]*>([^<]{0,200})<\/title>/i.exec(text)?.[1]?.trim() ?? "";
const looksHtml = (a: Answer) => /html/i.test(header(a, "content-type")) || /^\s*(<!doctype html|<html)/i.test(a.text.slice(0, 500));

// Who blocked the request, when the answer is a bot-protection page; undefined for an ordinary
// answer (a 404, a 500, a page). expect: what the address should return, "text" for robots.txt and
// sitemaps (where an HTML page about cookies is a cookie wall), "html" for a page. Signals that
// appear on ordinary pages too (Cloudflare's challenge-platform script) count only with a refusal
// status or a challenge title. Pure.
export function botProtection(a: Answer, expect: "text" | "html" = "html"): string | undefined {
  const refused = a.status === 403 || a.status === 429 || a.status === 503 || a.status === 401;
  const server = header(a, "server").toLowerCase();
  const head = a.text.slice(0, 20_000);
  const name = title(head);
  // Cloudflare: its own header, or its challenge page.
  if (/challenge/i.test(header(a, "cf-mitigated"))) return "Cloudflare";
  if (/^(just a moment|attention required|please wait)\b/i.test(name) && (server.includes("cloudflare") || /cdn-cgi|cf-/i.test(head)))
    return "Cloudflare";
  if (refused && (server.includes("cloudflare") || header(a, "cf-ray")) && /cdn-cgi\/challenge-platform|cf-chl|cf_chl|ray id/i.test(head))
    return "Cloudflare";
  // DataDome, Imperva Incapsula, HUMAN (PerimeterX), Kasada, AWS WAF, Sucuri, Akamai, F5.
  if (header(a, "x-datadome") || (refused && /captcha-delivery\.com|datadome/i.test(head))) return "DataDome";
  if (/_Incapsula_Resource|Incapsula incident ID/i.test(head) || (refused && header(a, "x-iinfo"))) return "Imperva";
  if (/px-captcha|_pxCaptcha|perimeterx/i.test(head) && (refused || head.length < 5000)) return "HUMAN (PerimeterX)";
  if (refused && Object.keys(a.headers).some((h) => h.startsWith("x-kpsdk"))) return "Kasada";
  if (header(a, "x-amzn-waf-action") || (refused && /aws-waf-token|awswaf/i.test(head))) return "AWS WAF";
  if (refused && (server.includes("sucuri") || /Sucuri WebSite Firewall/i.test(head))) return "Sucuri";
  if (refused && server.includes("akamai") && /access denied|reference #/i.test(head)) return "Akamai";
  if (/The requested URL was rejected\. Please consult with your administrator/i.test(head)) return "F5";
  // A bare 403 page counts only for the start page: a sitemap path a server forbids isn't a firewall.
  if (
    expect === "html" &&
    a.status === 403 &&
    /access denied|forbidden|you have been blocked|request blocked|bot/i.test(name) &&
    looksHtml(a)
  )
    return "bot protection";
  if (refused && /captcha|are you a robot|verify you are (a )?human|unusual traffic/i.test(head)) return "bot protection";
  // A cookie wall: robots.txt or a sitemap answered with an HTML page about cookies or consent.
  if (expect === "text" && a.status === 200 && looksHtml(a) && /cookie|consent|gdpr/i.test(head) && !/<urlset|<sitemapindex/i.test(head))
    return "a cookie wall";
  return undefined;
}
