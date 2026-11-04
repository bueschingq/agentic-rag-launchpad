// CI's console preview. Visits every dashboard page the way a partner would, saves desktop
// and phone screenshots, checks the numbers against the database, saves the settings form
// once, creates one customer, saves one widget change, and exits non-zero if anything is off.
// Runs against a console started on the demo seed. Deployments need Agentic RAG, so their
// form is only visited.
//
//   BASE_URL=http://127.0.0.1:3000 DATABASE_URL=… LAUNCHPAD_ADMIN_PASSWORD=… node apps/console/scripts/preview.ts preview/
//
// Playwright is the sniffer's dependency, hoisted to the workspace root; the console doesn't ship it.

import { mkdirSync, writeFileSync } from "node:fs";
import { auditLog, createDb, deployments, settings, tenantContacts, usageDaily } from "@launchpad/db";
import { eq, gte, sql } from "drizzle-orm";
import { chromium, type Page } from "playwright";
import { formatMoney } from "../src/lib/format.ts";

const base = (process.env.BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const out = process.argv[2] ?? "preview";
const password = process.env.LAUNCHPAD_ADMIN_PASSWORD;
const databaseUrl = process.env.DATABASE_URL;
if (!password || !databaseUrl) throw new Error("Set LAUNCHPAD_ADMIN_PASSWORD and DATABASE_URL.");
mkdirSync(out, { recursive: true });

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const problems: string[] = [];
const rows: string[] = [];

const { db, close } = createDb(databaseUrl, { max: 1 });
const browser = await chromium.launch();
const context = await browser.newContext({ httpCredentials: { username: "preview", password }, viewport: DESKTOP });
const page = await context.newPage();
const errors: string[] = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(e.message));

// Loads a page, screenshots it at both widths, and returns its main text.
async function visit(path: string, name: string, expectStatus = 200): Promise<string> {
  errors.length = 0;
  await page.setViewportSize(DESKTOP);
  const res = await page.goto(base + path, { waitUntil: "networkidle" });
  const status = res?.status() ?? 0;
  // textContent, not innerText: hidden text (tooltips, screen-reader summaries) gets checked too.
  const main = page.locator("main");
  const text = (await main.textContent().catch(() => "")) ?? "";
  // The browser logs the 404 itself as a console error.
  const notes = errors.filter((e) => !(expectStatus === 404 && e.includes("404")));
  if (status !== expectStatus) notes.push(`HTTP ${status}, expected ${expectStatus}`);
  for (const junk of ["NaN", "undefined", "Infinity", "[object Object]"]) if (text.includes(junk)) notes.push(`shows "${junk}"`);
  await page.screenshot({ path: `${out}/${name}-desktop.png`, fullPage: true });
  await page.setViewportSize(PHONE);
  if (await sideways(page)) notes.push("scrolls sideways on a phone");
  await page.screenshot({ path: `${out}/${name}-phone.png`, fullPage: true });
  await page.setViewportSize(DESKTOP);
  record(path, status, notes);
  return text;
}

function sideways(p: Page): Promise<boolean> {
  return p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
}

function record(what: string, status: number | string, notes: string[]) {
  if (notes.length) problems.push(`${what}: ${notes.join("; ")}`);
  rows.push(`| \`${what}\` | ${status} | ${notes.join("; ") || "ok"} |`);
}

try {
  // Fleet, and the month's total cost straight from the database.
  const fleet = await visit("/", "fleet");
  const today = new Date().toISOString().slice(0, 10);
  const [month] = await db
    .select({ cents: sql<string>`coalesce(sum(${usageDaily.costCents}), 0)` })
    .from(usageDaily)
    .where(gte(usageDaily.day, `${today.slice(0, 7)}-01`));
  const monthTotal = formatMoney(Number(month?.cents ?? 0), "USD");
  record("fleet: cost this month matches the database", monthTotal, fleet.includes(monthTotal) ? [] : [`${monthTotal} not on the page`]);
  // The demo seed sets up each of these; budget alerts depend on the day of the month, so they're left out.
  const expected = ["Last sync failed", "Provisioning failed", "No sync for 5 days", "Quality down"];
  record(
    "fleet: alerts from the demo seed",
    "",
    expected.filter((alert) => !fleet.includes(alert)).map((alert) => `missing "${alert}"`),
  );

  // Every customer page the fleet links to.
  const links = await page.locator('a[href^="/customers/"]').evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? ""));
  const customers = [...new Set(links)].filter((href) => href !== "/customers/new");
  if (customers.length === 0) record("fleet: links to customers", "none", ["no customer links"]);
  for (const [i, href] of customers.entries()) await visit(href, `customer-${i + 1}`);
  await visit("/customers/00000000-0000-4000-8000-000000000000", "customer-missing", 404);

  // Costs page and its CSV export.
  const costs = await visit("/costs", "costs");
  record("costs: total matches the database", monthTotal, costs.includes(monthTotal) ? [] : [`${monthTotal} not on the page`]);
  const csv = await page.request.get(`${base}/costs/export?month=${today.slice(0, 7)}`);
  const lines = (await csv.text()).trim().split("\r\n");
  const csvNotes = csv.ok() && lines[0]?.startsWith("Customer,Month,") && lines.length > 1 ? [] : [`unexpected CSV: ${lines[0]}`];
  record("costs: CSV export", csv.status(), csvNotes);
  record("costs: CSV rejects a bad month", (await page.request.get(`${base}/costs/export?month=nope`)).status(), []);

  // Settings: save a new markup and check it reached the database and the audit log.
  await visit("/settings", "settings");
  await page.fill("#markupPercent", "42");
  await Promise.all([page.waitForURL(/saved=1/), page.click("button[type=submit]")]);
  const [saved] = await db.select({ markup: settings.markupPercent }).from(settings).where(eq(settings.id, 1));
  const [audit] = await db.select({ n: sql<string>`count(*)` }).from(auditLog).where(eq(auditLog.action, "settings.update"));
  const settingsNotes = [
    ...(saved?.markup === 42 ? [] : [`markup is ${saved?.markup}, expected 42`]),
    ...(Number(audit?.n) === 1 ? [] : ["no audit record"]),
    ...((await page.locator("[role=status]").textContent())?.includes("saved") ? [] : ["no confirmation shown"]),
  ];
  record("settings: save", "42%", settingsNotes);
  await page.screenshot({ path: `${out}/settings-saved-desktop.png`, fullPage: true });

  // New customer: an empty submit marks what's missing; a filled one lands on the customer page
  // with its contact stored and the creation audited.
  await visit("/customers/new", "customer-new");
  await page.click("button[type=submit]");
  // Within main: Next.js's route announcer is a role=alert too.
  await page.locator("main [role=alert]").waitFor();
  const invalid = await page.locator("[aria-invalid=true]").count();
  record("customer form: empty submit", `${invalid} marked`, invalid > 0 ? [] : ["no field marked invalid"]);
  await page.screenshot({ path: `${out}/customer-new-errors-desktop.png`, fullPage: true });
  await page.fill("#name", "Preview Customer");
  await page.fill('[id="contacts.0.name"]', "Pat Preview");
  await page.fill('[id="contacts.0.email"]', "pat@preview.example");
  await page.selectOption('[id="contacts.0.kbRole"]', "contributor");
  // Billing can wait, so it starts folded.
  await page.click(".billing-details > summary");
  await page.selectOption('[id="billing.terms"]', "net_30");
  await Promise.all([page.waitForURL(/created=1/), page.click("button[type=submit]")]);
  const [contact] = await db
    .select({ kbRole: tenantContacts.kbRole, isPrimary: tenantContacts.isPrimary })
    .from(tenantContacts)
    .where(eq(tenantContacts.email, "pat@preview.example"));
  const [createdAudit] = await db.select({ n: sql<string>`count(*)` }).from(auditLog).where(eq(auditLog.action, "customer.create"));
  const customerPage = (await page.locator("main").textContent()) ?? "";
  record("customer form: create", "created", [
    ...(contact?.kbRole === "contributor" && contact.isPrimary ? [] : ["contact not stored as primary contributor"]),
    ...(Number(createdAudit?.n) === 1 ? [] : ["no audit record"]),
    ...(customerPage.includes("Net 30") ? [] : ["billing terms not shown"]),
  ]);
  await page.screenshot({ path: `${out}/customer-created-desktop.png`, fullPage: true });

  await visit("/deployments/new", "deployment-new");

  // Widget page on a demo deployment: the preview frame renders the widget, and a layout
  // change reaches the database and the audit log. CI has no sniffer, so there's no scan.
  const [demo] = await db.select({ id: deployments.id, tenantId: deployments.tenantId }).from(deployments).limit(1);
  if (!demo) record("widget page", "none", ["no deployment to configure"]);
  else {
    await visit(`/customers/${demo.tenantId}/deployments/${demo.id}/widget`, "widget");
    const rendered = await page
      .waitForFunction(
        () =>
          (document.querySelector("iframe.preview-frame") as HTMLIFrameElement | null)?.contentDocument?.querySelector("arag-chat")
            ?.shadowRoot?.childElementCount,
        null,
        { timeout: 10_000 },
      )
      .then(
        () => true,
        () => false,
      );
    await page.check('input[name="mode"][value="chat"]');
    await Promise.all([
      // A regex: a plain hasText is a case-insensitive substring, and "Unsaved changes" would match.
      page.locator(".save-bar [role=status]", { hasText: /^Saved\./ }).waitFor(),
      page.click(".save-bar button[type=submit]"),
    ]);
    const [widget] = await db.select({ settings: deployments.widgetSettings }).from(deployments).where(eq(deployments.id, demo.id));
    const [widgetAudit] = await db.select({ n: sql<string>`count(*)` }).from(auditLog).where(eq(auditLog.action, "deployment.widget"));
    record("widget: preview and save", "chat", [
      ...(rendered ? [] : ["the preview didn't render the widget"]),
      ...(widget?.settings.mode === "chat" ? [] : [`mode is ${widget?.settings.mode}, expected chat`]),
      ...(Number(widgetAudit?.n) === 1 ? [] : ["no audit record"]),
    ]);
    await page.screenshot({ path: `${out}/widget-saved-desktop.png`, fullPage: true });
  }

  // Every demo deployment's page: a stage that agrees with the rest of the page.
  const all = await db
    .select({ id: deployments.id, tenantId: deployments.tenantId, status: deployments.status, name: deployments.name })
    .from(deployments);
  for (const [i, d] of all.entries()) {
    const base = `/customers/${d.tenantId}/deployments/${d.id}`;
    const text = await visit(base, `deployment-${i + 1}`);
    const notes: string[] = [];
    if (d.status === "draft" && !text.includes("Start provisioning")) notes.push("a draft offers no Start provisioning");
    if (d.status === "failed" && !text.includes("Stopped at")) notes.push("a failed deployment doesn't say where it stopped");
    if (/Not started/.test(text) && d.status !== "draft") notes.push('shows "Not started" for a non-draft deployment');
    record(`deployment ${d.name}: stage`, d.status, notes);
  }
  const live = all.find((d) => d.status === "live")!;
  const liveBase = `/customers/${live.tenantId}/deployments/${live.id}`;
  await visit(`${liveBase}/content`, "content");
  await visit(`${liveBase}/edit`, "deployment-edit");
  await visit(`/customers/${live.tenantId}/edit`, "customer-edit");
  await visit("/settings/users", "users");

  // Fleet's "Needs attention" finds the failed deployment.
  const attention = await visit("/?show=attention", "fleet-attention");
  record("fleet: needs attention", "", attention.includes("Patient portal FAQ") ? [] : ["the failed deployment isn't listed"]);

  // Install guide: share a link, then open it signed out.
  await visit(`${liveBase}/install`, "install");
  await Promise.all([page.waitForURL(/link=/), page.click("text=Share a link")]);
  const guideLink = new URL(page.url()).searchParams.get("link") ?? "";
  const outsider = await browser.newContext({ viewport: DESKTOP });
  const shared = await outsider.newPage();
  const guide = await shared.goto(guideLink.replace(/^https?:\/\/[^/]+/, base));
  const guideText = (await shared.locator("main").textContent()) ?? "";
  record("install guide: share link, signed out", guide?.status() ?? 0, [
    ...(guide?.status() === 200 ? [] : ["didn't open"]),
    ...(guideText.includes("Page template") || guideText.includes("page template") ? [] : ["no Sitefinity steps"]),
    ...(/writer key/i.test(guideText) && !/sends it separately/.test(guideText) ? ["mentions a key"] : []),
  ]);
  await shared.screenshot({ path: `${out}/install-shared-desktop.png`, fullPage: true });

  // Report: share a link, then open it signed out: no money anywhere.
  await visit(`/customers/${live.tenantId}/report`, "report");
  await Promise.all([page.waitForURL(/link=/), page.click("text=Share a link")]);
  const reportLink = new URL(page.url()).searchParams.get("link") ?? "";
  const report = await shared.goto(reportLink.replace(/^https?:\/\/[^/]+/, base));
  const reportText = (await shared.locator("main").textContent()) ?? "";
  record("report: share link, signed out", report?.status() ?? 0, [
    ...(report?.status() === 200 ? [] : ["didn't open"]),
    ...(/[$€£]\s?\d/.test(reportText) ? ["shows money"] : []),
    ...(reportText.includes("What visitors asked most") ? [] : ["no questions section"]),
  ]);
  await shared.screenshot({ path: `${out}/report-shared-desktop.png`, fullPage: true });
  await outsider.close();
} finally {
  await browser.close();
  await close();
}

const report = ["# Console preview", "", "| Check | Result | Notes |", "| --- | --- | --- |", ...rows, ""].join("\n");
writeFileSync(`${out}/report.md`, report);
console.log(report);
if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
