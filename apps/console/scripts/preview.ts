// CI's console preview. Visits every dashboard page the way a partner would, saves desktop
// and phone screenshots, checks the numbers against the database, saves the settings form
// once, and exits non-zero if anything is off. Runs against a console started on the demo seed.
//
//   BASE_URL=http://127.0.0.1:3000 DATABASE_URL=… LAUNCHPAD_ADMIN_PASSWORD=… node apps/console/scripts/preview.ts preview/
//
// Playwright is the sniffer's dependency, hoisted to the workspace root; the console doesn't ship it.

import { mkdirSync, writeFileSync } from "node:fs";
import { auditLog, createDb, settings, usageDaily } from "@launchpad/db";
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
  const expected = ["Last sync failed", "Provisioning failed", "No sync for 5 days", "Answer quality down"];
  record("fleet: alerts from the demo seed", "", expected.filter((alert) => !fleet.includes(alert)).map((alert) => `missing "${alert}"`));

  // Every customer page the fleet links to.
  const links = await page.locator('a[href^="/customers/"]').evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? ""));
  const customers = [...new Set(links)];
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
