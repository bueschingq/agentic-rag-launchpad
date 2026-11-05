// Runs the sniffer's in-page code on a made-up page with the traps the round-1 scans fell
// into: a carousel's "pause" button, a cookie wall with "Accept all", a chat widget, a small
// navigation button repeated across the page next to the hero's call to action, and customer
// logos below the site's own. Nothing leaves the machine: the page is set from a string.
//
//   node spike/scan/extract-check.ts

import assert from "node:assert/strict";
import { chromium } from "playwright";
import { deriveTheme, siteDetails } from "../../apps/sniffer/src/derive.ts";
import { extractStyles, hideOverlays } from "../../apps/sniffer/src/extract.ts";

const PAGE = `<!doctype html><html lang="en-gb"><head><title>Home | Acme Dental</title>
<link rel="alternate" hreflang="en-gb" href="https://acme.example/">
<link rel="alternate" hreflang="es-es" href="https://acme.example/es/">
<link rel="alternate" hreflang="x-default" href="https://acme.example/">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Acme Dental","logo":"https://acme.example/brand.png"}</script>
<style>
  body { margin: 0; font: 16px/1.5 Arial, sans-serif; }
  header { display: flex; justify-content: space-between; padding: 12px; }
  .nav-cta { background: rgb(34, 94, 255); color: #fff; padding: 8px 12px; border: 0; }
  .hero { height: 600px; padding: 40px; }
  .hero-cta { display: inline-block; background: rgb(235, 2, 73); color: #fff; padding: 18px 36px; font-size: 20px; text-decoration: none; }
  .carousel-pause { background: rgb(12, 42, 111); color: #fff; width: 90px; height: 36px; border: 0; }
  #onetrust-banner-sdk { position: fixed; inset: 0; background: rgb(0 0 0 / 0.6); z-index: 1000; }
  #onetrust-banner-sdk button { background: rgb(0, 128, 0); color: #fff; width: 160px; height: 44px; border: 0; }
  #intercom-container { position: fixed; right: 16px; bottom: 16px; width: 60px; height: 60px; background: rgb(120, 0, 200); }
  .customers img { width: 120px; height: 40px; }
</style></head><body>
<header><a href="/"><img src="https://acme.example/img/acme-logo.svg" alt="Acme Dental logo" width="120" height="40"></a>
  <nav><button class="nav-cta">Free Trial</button></nav></header>
<section class="hero"><button class="carousel-pause" aria-label="pause">pause</button>
  <a class="hero-cta" href="/book">Book a visit</a></section>
<section><button class="nav-cta">Free Trial</button><button class="nav-cta">Free Trial</button><button class="nav-cta">Free Trial</button></section>
<section class="customers"><img src="https://acme.example/img/customer-logo.png" alt="Customer logo"></section>
<div id="onetrust-banner-sdk"><p>We use cookies.</p><button>Accept all</button></div>
<div id="intercom-container"></div>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
// Nothing loads from the network: images and the like are refused.
await page.route("**/*", (route) => route.abort());
await page.setContent(PAGE);
const raw = await page.evaluate(extractStyles);
const texts = raw.buttons.map((b) => b.text);
assert.ok(!texts.includes("pause"), `media controls skipped: ${texts}`);
assert.ok(!texts.includes("Accept all"), `consent buttons skipped: ${texts}`);
const derived = deriveTheme(raw);
assert.equal(derived.input.color?.primary, "#eb0249", "the hero's call to action");
assert.ok((derived.confidence["color.primary"] ?? 1) < 0.6, "one button: Check this");
assert.equal(raw.logo, "https://acme.example/img/acme-logo.svg");
const details = siteDetails(raw, "https://www.acme.example/");
assert.equal(details.siteName, "Acme Dental");
assert.deepEqual(details.languages, ["en-gb", "es-es"]);
assert.equal(details.pageLanguage, "en-gb");

const hidden = await page.evaluate(hideOverlays);
assert.ok(hidden >= 2, `hid ${hidden}`);
for (const id of ["onetrust-banner-sdk", "intercom-container"]) {
  assert.equal(await page.locator(`#${id}`).isVisible(), false, `${id} hidden for the screenshot`);
}
assert.ok(await page.locator(".hero-cta").isVisible(), "the site itself stays");
await browser.close();
console.log("extract-check: all good", { primary: derived.input.color?.primary, buttons: texts, ...details });
