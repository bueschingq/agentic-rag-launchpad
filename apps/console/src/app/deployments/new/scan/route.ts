// The scan New deployment starts when the site address is entered, alongside the content plan.
// The form names it with a token; Create saves it once the deployment exists (saveScan), and
// nothing from it is applied to the widget: the widget page shows it as "From the scan".

import { currentUser } from "@/lib/auth.ts";
import { siteAddress, versionFromScan } from "@/lib/content-form.ts";
import { ScanError } from "@/lib/sniffer.ts";
import { startScan } from "../site-cache.ts";

export const dynamic = "force-dynamic";

const TOKEN = /^[0-9a-f-]{36}$/;

export async function POST(request: Request) {
  await currentUser();
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const site = siteAddress(String(body.site ?? ""));
  const token = String(body.token ?? "");
  if (!site || !TOKEN.test(token))
    return Response.json({ error: "Enter the site's address, e.g. https://www.example.com." }, { status: 400 });
  try {
    const scan = await startScan(token, site);
    if (!scan) return Response.json({ error: "The site didn't load in the scanner." }, { status: 422 });
    return Response.json({
      finalUrl: scan.finalUrl,
      platform: scan.platform,
      sitefinityVersion: versionFromScan(scan.platform),
      sitemapPages: scan.sitemapPages,
      sitemapTruncated: scan.sitemapTruncated,
      ...(scan.siteName && { siteName: scan.siteName }),
    });
  } catch (err) {
    if (err instanceof ScanError) return Response.json({ error: err.message }, { status: 422 });
    console.error("[scan]", err);
    return Response.json({ error: "The scan failed. The widget page can scan again later." }, { status: 500 });
  }
}
