// The widget in a real browser, as built: under a strict Content Security Policy, added the way
// Tag Manager adds it, kept off excluded pages and Sitefinity's editor, and checked with axe
// in all four layouts. Also the visitor's side of reply quality, the contact form and events,
// a header that keeps the chat's name and "Talk to a person" apart in every language, and
// Resume reaching a chat left open while paused.
//
//   npm run test:browser --workspace @launchpad/widget     (builds arag-chat.js first)

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import AxeBuilder from "@axe-core/playwright";
import { LANGUAGES, questionHash, resolveTheme, widgetStrings } from "@launchpad/theme";
import { type Browser, chromium, type Page } from "playwright";
import { EVENTFUL, PRIMARY, type Recorded, ROUTED, startFixture, UNLABELLED_PAGE } from "./fixture.ts";

let browser: Browser;
let site: { origin: string; recorded: Recorded; close: () => Promise<void> };

before(async () => {
  site = await startFixture();
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await site?.close();
});

async function open(path: string, options: { width?: number; height?: number; locale?: string } = {}) {
  const context = await browser.newContext({
    viewport: { width: options.width ?? 1280, height: options.height ?? 800 },
    locale: options.locale ?? "en-US",
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${site.origin}${path}`);
  return { page, context, errors };
}

const chat = (page: Page) => page.locator("arag-chat");
// Inside the shadow root: Playwright's CSS locators pierce open shadow roots.
const rendered = (page: Page) => page.waitForFunction(() => (document.querySelector("arag-chat")?.shadowRoot?.childElementCount ?? 0) > 0);
const lastReplyDone = (page: Page) =>
  page.waitForFunction(() => {
    const replies = document.querySelector("arag-chat")?.shadowRoot?.querySelectorAll(".message.assistant");
    const last = replies?.[replies.length - 1];
    return Boolean(last && !last.hasAttribute("aria-busy") && last.querySelector(".answer")?.textContent);
  });

async function ask(page: Page, question: string) {
  await chat(page).locator("textarea").fill(question);
  await chat(page).locator("textarea").press("Enter");
  await lastReplyDone(page);
}

describe("under a strict Content Security Policy", () => {
  it("is fully styled with style-src 'self'", async () => {
    const { page, context, errors } = await open("/page?mode=floating&csp=strict");
    await rendered(page);
    const launcher = chat(page).locator(".launcher");
    const background = await launcher.evaluate((el) => getComputedStyle(el).backgroundColor);
    assert.equal(background, "rgb(15, 118, 110)", `launcher painted ${PRIMARY}`);
    assert.equal(await launcher.evaluate((el) => getComputedStyle(el).position), "fixed");
    assert.deepEqual(
      errors.filter((e) => /Content Security Policy|style/i.test(e)),
      [],
    );
    await context.close();
  });

  it("says once, in the console, that connect-src blocks the console", async () => {
    const { page, context, errors } = await open("/page?mode=floating&csp=noconnect");
    await page.waitForTimeout(1500);
    const ours = errors.filter((e) => e.startsWith("[arag-chat]"));
    assert.equal(ours.length, 1, errors.join("\n"));
    assert.match(ours[0]!, /Content Security Policy.*connect-src/);
    await context.close();
  });
});

describe("embedding", () => {
  for (const how of ["create", "gtm"]) {
    it(`keeps the deployment id when a tag manager adds the snippet (${how})`, async () => {
      const { page, context } = await open(`/gtm?how=${how}`);
      await rendered(page);
      assert.equal(await chat(page).getAttribute("deployment"), "e2e-floating");
      assert.ok(await chat(page).locator(".launcher").isVisible());
      await context.close();
    });
  }

  it("stays off excluded pages and out of Sitefinity's page editor", async () => {
    for (const path of ["/login", "/home/Action/Edit", "/page?sfaction=edit"]) {
      const { page, context } = await open(path);
      await page.waitForTimeout(800);
      const children = await page.evaluate(() => document.querySelector("arag-chat")?.shadowRoot?.childElementCount ?? 0);
      assert.equal(children, 0, path);
      await context.close();
    }
  });
});

describe("replies", () => {
  it("renders markdown and labelled sources, matches a CTA on a whole word, and offers thumbs", async () => {
    const { page, context } = await open("/page?mode=chat");
    await rendered(page);
    await ask(page, "What are your opening hours and prices?");
    const reply = chat(page).locator(".message.assistant").last();
    assert.equal(await reply.locator(".answer strong").textContent(), "Monday to Friday");
    assert.equal(await reply.locator(".answer li").count(), 2);
    assert.doesNotMatch((await reply.locator(".answer").textContent()) ?? "", /\*\*/);
    assert.equal(await reply.locator(".answer a").getAttribute("href"), `${site.origin}/book`);
    assert.equal(await reply.locator(".sources-label").textContent(), "Sources");
    assert.deepEqual(await reply.locator(".source-domain").allTextContents(), ["partner-clinic.example"]);
    for (const box of await reply.locator(".sources a").evaluateAll((links) => links.map((a) => a.getBoundingClientRect().height))) {
      assert.ok(box >= 24, `source link ${box}px tall`);
    }
    assert.equal(await reply.locator(".cta").textContent(), "See pricing");
    assert.equal(await reply.locator(".thumb").count(), 2);
    await context.close();
  });

  it("treats Agentic RAG's no-context reply as no answer, with the handoff and no sources", async () => {
    const { page, context } = await open("/page?mode=chat");
    await rendered(page);
    await ask(page, "Do you sell bicycles?");
    const reply = chat(page).locator(".message.assistant").last();
    assert.match((await reply.textContent()) ?? "", /couldn't find an answer/);
    assert.equal(await reply.locator(".sources").count(), 0);
    assert.equal(await reply.locator(".handoff .contact").count(), 1);
    assert.equal(await reply.locator(".thumb").count(), 0);
    await context.close();
  });

  it("doesn't fire a CTA inside another word", async () => {
    const { page, context } = await open("/page?mode=chat");
    await rendered(page);
    await ask(page, "Do you host costume parties?");
    assert.equal(await chat(page).locator(".message.assistant").last().locator(".cta").count(), 0);
    await context.close();
  });

  it("keeps the question after an error and asks it again on Try again", async () => {
    const { page, context } = await open("/page?mode=chat");
    await rendered(page);
    await chat(page).locator("textarea").fill("Will this fail?");
    await chat(page).locator("textarea").press("Enter");
    await chat(page).locator(".retry").waitFor();
    assert.equal(await chat(page).locator(".message.user").last().textContent(), "Will this fail?");
    await chat(page).locator(".retry").click();
    await lastReplyDone(page);
    assert.equal(await chat(page).locator(".message.user").count(), 1);
    assert.equal(await chat(page).locator(".message.assistant").last().locator(".sources").count(), 1);
    await context.close();
  });

  it("announces a streamed answer once, from a live region outside the conversation", async () => {
    const { page, context } = await open("/page?mode=chat");
    await rendered(page);
    assert.equal(await chat(page).locator(".log").getAttribute("aria-live"), null);
    await ask(page, "When are you open?");
    await page.waitForTimeout(200);
    const announced = await chat(page).locator("[aria-live]").textContent();
    assert.match(announced ?? "", /^We're open Monday to Friday/);
    await context.close();
  });
});

describe("the visitor's way around", () => {
  it("keeps focus in the question box after a starter question, from the keyboard", async () => {
    const { page, context } = await open("/page?mode=chat");
    await rendered(page);
    await chat(page).locator(".starter").first().focus();
    await page.keyboard.press("Enter");
    const focused = await page.evaluate(() => document.querySelector("arag-chat")?.shadowRoot?.activeElement?.tagName);
    assert.equal(focused, "TEXTAREA");
    await context.close();
  });

  it("follows the visitor to the next page in the tab, with no cookies", async () => {
    const { page, context } = await open("/page?mode=floating");
    await rendered(page);
    await chat(page).locator(".launcher").click();
    await ask(page, "When are you open?");
    await chat(page).locator(".sources a").first().click();
    await page.waitForURL(/\/hours/);
    await rendered(page);
    assert.equal(await chat(page).locator(".message.user").textContent(), "When are you open?");
    assert.ok(await chat(page).locator(".panel").isVisible(), "the panel reopens");
    assert.deepEqual(await context.cookies(), []);
    await context.close();
  });

  it("goes full screen on a phone with 16px question text, and the page behind stays put", async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    await page.goto(`${site.origin}/page?mode=floating`);
    await rendered(page);
    await chat(page).locator(".launcher").click();
    const size = await chat(page)
      .locator("textarea")
      .evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
    assert.ok(size >= 16, `${size}px`);
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).overflow), "hidden");
    await chat(page).locator(".close").click();
    assert.notEqual(await page.evaluate(() => getComputedStyle(document.documentElement).overflow), "hidden");
    await context.close();
  });

  it("speaks the page's language, including the partner's copy, and matches its keywords", async () => {
    const { page, context } = await open("/page?mode=chat&lang=es", { locale: "en-US" });
    await rendered(page);
    assert.equal(await chat(page).locator(".message.assistant").first().textContent(), "¡Hola! Pregunta por nuestra clínica.");
    assert.deepEqual(await chat(page).locator(".starter").allTextContents(), ["¿Cuándo abren?"]);
    await ask(page, "¿Cuál es el precio?");
    assert.equal(await chat(page).locator(".cta").last().textContent(), "Ver precios");
    assert.equal(await chat(page).locator(".cta").last().getAttribute("href"), `${site.origin}/es/precios`, "the Spanish page");
    assert.equal(await chat(page).locator(".sources-label").last().textContent(), "Fuentes");
    await context.close();
  });

  it("takes a lead without personal data reaching the events, and the transcript only when asked", async () => {
    site.recorded.events.length = 0;
    site.recorded.leads.length = 0;
    const { page, context } = await open("/page?mode=chat");
    await rendered(page);
    await ask(page, "Do you sell bicycles?");
    await chat(page).locator(".handoff button").click();
    const form = chat(page).locator("form.lead");
    await form.locator("button[type=submit]").click();
    assert.equal(await form.locator('[aria-invalid="true"]').count(), 2, "email and consent");
    await form.locator("input[type=email]").fill("ana@clinic.example");
    await form.locator("textarea").fill("Please call me back about bikes.");
    await form.locator("input[type=checkbox]").first().check();
    await form.locator("button[type=submit]").click();
    await chat(page).locator(".notice").waitFor();
    assert.equal(site.recorded.leads.length, 1);
    const lead = site.recorded.leads[0]!;
    assert.deepEqual(lead.fields, { email: "ana@clinic.example", message: "Please call me back about bikes." });
    assert.equal(lead.consent, true);
    assert.equal(lead.transcript, undefined);
    assert.equal(lead.page_url, `${site.origin}/page`);
    await page.goto("about:blank"); // pagehide: the rest of the events go with the beacon
    await new Promise((r) => setTimeout(r, 500));
    const names = site.recorded.events.map((e) => e.name);
    for (const name of ["arag_chat_open", "arag_chat_question", "arag_chat_answer", "arag_chat_handoff_click", "arag_chat_lead_submit"]) {
      assert.ok(names.includes(name), `${name} in ${names.join(", ")}`);
    }
    const ids = new Set(site.recorded.events.map((e) => e.conversation_id));
    assert.equal(ids.size, 1);
    const text = JSON.stringify(site.recorded.events);
    assert.doesNotMatch(text, /bicycles|ana@clinic|call me back/);
    assert.equal(site.recorded.events.find((e) => e.name === "arag_chat_answer")?.answered, false);
    await context.close();
  });
});

describe("accessibility (axe, WCAG 2.2 AA)", () => {
  for (const mode of ["floating", "popup", "chat", "embedded"]) {
    it(`has no serious or critical issues in the ${mode} layout`, async () => {
      const { page, context } = await open(`/page?mode=${mode}`);
      await rendered(page);
      if (mode === "floating") await chat(page).locator(".launcher").click();
      if (mode === "popup") await chat(page).locator(".trigger").click();
      await ask(page, "What are your opening hours and prices?");
      // And the handoff card under a reworded no-answer (round 4).
      await ask(page, "How do I get slime out of carpet?");
      const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
      const serious = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      assert.deepEqual(
        serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
        [],
      );
      await context.close();
    });
  }
});

describe("on a phone, the chat is a modal", () => {
  const phone = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
  // Where focus is: inside the widget's panel, or somewhere else on the page.
  const focusIn = (page: Page) =>
    page.evaluate(() => {
      const host = document.querySelector("arag-chat");
      const active = host?.shadowRoot?.activeElement;
      if (document.activeElement !== host || !active) return `outside: ${document.activeElement?.tagName ?? "nothing"}`;
      return active.closest(".panel") ? "panel" : `widget: ${active.className}`;
    });

  it("keeps Tab inside the open panel at 390 px, hides the chat button, and gives focus back on Escape and Close", async () => {
    const context = await browser.newContext(phone);
    const page = await context.newPage();
    await page.goto(`${site.origin}/page?mode=floating`);
    await rendered(page);
    await chat(page).locator(".launcher").click();
    await ask(page, "When are you open?");
    const panel = chat(page).locator(".panel");
    assert.equal(await panel.evaluate((d) => d.matches(":modal")), true);
    assert.equal(await panel.getAttribute("aria-modal"), "true");
    assert.equal(await chat(page).locator(".launcher").isHidden(), true);
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press(i % 7 === 6 ? "Shift+Tab" : "Tab");
      assert.equal(await focusIn(page), "panel", `after ${i + 1} presses`);
    }
    await page.keyboard.press("Escape");
    assert.equal(await panel.isHidden(), true);
    assert.equal(await page.evaluate(() => document.querySelector("arag-chat")?.shadowRoot?.activeElement?.className), "launcher");
    await chat(page).locator(".launcher").click();
    await chat(page).locator(".close").click();
    assert.equal(await page.evaluate(() => document.querySelector("arag-chat")?.shadowRoot?.activeElement?.className), "launcher");
    await context.close();
  });

  it("stays a non-modal panel on a desktop", async () => {
    const { page, context } = await open("/page?mode=floating");
    await rendered(page);
    await chat(page).locator(".launcher").click();
    const panel = chat(page).locator(".panel");
    assert.equal(await panel.isVisible(), true);
    assert.equal(await panel.evaluate((d) => d.matches(":modal")), false);
    assert.equal(await panel.getAttribute("aria-modal"), null);
    assert.equal(await chat(page).locator(".launcher").isVisible(), true);
    await context.close();
  });

  it("turns modal when the window narrows to a phone's width with the chat open, and back, keeping focus", async () => {
    const { page, context } = await open("/page?mode=floating");
    await rendered(page);
    await chat(page).locator(".launcher").click();
    await ask(page, "When are you open?");
    await chat(page).locator("textarea").focus();
    const panel = chat(page).locator(".panel");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => document.querySelector("arag-chat")?.shadowRoot?.querySelector(".panel")?.matches(":modal"));
    assert.equal(await panel.getAttribute("aria-modal"), "true");
    assert.equal(await chat(page).locator(".launcher").isHidden(), true);
    assert.equal(await focusIn(page), "panel");
    assert.equal(await chat(page).locator(".message.user").count(), 1, "the conversation stays");
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      assert.equal(await focusIn(page), "panel", `after ${i + 1} presses`);
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForFunction(() => !document.querySelector("arag-chat")?.shadowRoot?.querySelector(".panel")?.matches(":modal"));
    assert.equal(await panel.isVisible(), true);
    assert.equal(await panel.getAttribute("aria-modal"), null);
    assert.equal(await chat(page).locator(".launcher").isVisible(), true);
    assert.equal(await focusIn(page), "panel");
    await context.close();
  });

  it("keeps another site's domain on one line under a source, never broken mid-word", async () => {
    const context = await browser.newContext(phone);
    const page = await context.newPage();
    await page.goto(`${site.origin}/page?mode=floating`);
    await rendered(page);
    await chat(page).locator(".launcher").click();
    await ask(page, "When are you open?");
    const domain = chat(page).locator(".source-domain").last();
    const lines = await domain.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return new Set(Array.from(range.getClientRects()).map((r) => Math.round(r.top))).size;
    });
    assert.equal(lines, 1);
    const inside = await domain.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const bubble = el.closest(".message")!.getBoundingClientRect();
      return box.right <= bubble.right + 0.5;
    });
    assert.ok(inside, "within the answer");
    await context.close();
  });
});

describe("a cookie bar along the bottom", () => {
  for (const [width, height] of [
    [1280, 800],
    [390, 844],
  ] as const) {
    it(`lifts the chat button above a 59 px OneTrust-style banner, with no target-size issue, at ${width} px`, async () => {
      const { page, context } = await open("/page?mode=floating&banner=onetrust", { width, height });
      await rendered(page);
      await page.locator("#onetrust-banner-sdk").waitFor();
      const launcher = chat(page).locator(".launcher");
      await page.waitForFunction(() => {
        const button = document.querySelector("arag-chat")?.shadowRoot?.querySelector(".launcher")?.getBoundingClientRect();
        const bar = document.getElementById("onetrust-banner-sdk")?.getBoundingClientRect();
        return Boolean(button && bar && button.bottom <= bar.top);
      });
      const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
      assert.deepEqual(
        violations.filter((v) => v.id === "target-size").map((v) => v.nodes.map((n) => n.target.join(" ")).join(", ")),
        [],
      );
      // Accept closes the bar; the button goes back down.
      const lifted = (await launcher.boundingBox())!.y;
      await page.locator("#onetrust-accept-btn-handler").click();
      await page.waitForFunction(
        (y) => (document.querySelector("arag-chat")?.shadowRoot?.querySelector(".launcher")?.getBoundingClientRect().top ?? 0) > y + 50,
        lifted,
      );
      await context.close();
    });
  }
});

describe("the publish gate and Pause", () => {
  it("shows nothing before sign-off, and says why once in the console", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const info: string[] = [];
    page.on("console", (m) => m.type() === "info" && info.push(m.text()));
    await page.goto(`${site.origin}/page?mode=floating&dep=unpublished`);
    await page.waitForTimeout(1000);
    assert.equal(await page.evaluate(() => document.querySelector("arag-chat")?.shadowRoot?.childElementCount ?? 0), 0);
    assert.deepEqual(info, ["[arag-chat] This chat isn't published yet: it shows once it's signed off in the console."]);
    await context.close();
  });

  it("checks the status before a question once the last check is 30 s old, and doesn't ask while paused", async () => {
    site.recorded.paused = false;
    const context = await browser.newContext();
    // The page's clock, moved on by the test.
    await context.addInitScript(() => {
      const real = Date.now.bind(Date);
      Date.now = () => real() + ((globalThis as { skew?: number }).skew ?? 0);
    });
    const page = await context.newPage();
    await page.goto(`${site.origin}/page?mode=chat`);
    await rendered(page);
    const statusBefore = site.recorded.statusRequests;
    await ask(page, "When are you open?");
    assert.equal(site.recorded.statusRequests, statusBefore, "the config's word is fresh");
    site.recorded.paused = true;
    const asks = site.recorded.asks.length;
    await page.evaluate(() => {
      (globalThis as { skew?: number }).skew = 31_000;
    });
    await chat(page).locator("textarea").fill("Do you take new patients?");
    await chat(page).locator("textarea").press("Enter");
    await chat(page).getByText("Chat is unavailable right now.").waitFor();
    assert.equal(site.recorded.statusRequests, statusBefore + 1);
    assert.equal(site.recorded.asks.length, asks, "not asked");
    assert.equal(await chat(page).locator("textarea").count(), 0);
    site.recorded.paused = false;
    await context.close();
  });
});

describe("a lead carries consent, trigger and attribution", () => {
  it("sends the landing page's campaign tags, the button's label and the consent wording, and nothing else from the address", async () => {
    site.recorded.leads.length = 0;
    const { page, context } = await open("/page?mode=chat&utm_source=linkedin&utm_campaign=q4&email=x@y.z&gclid=Cj0KCQ");
    await rendered(page);
    await page.goto(`${site.origin}/hours?mode=chat`);
    await rendered(page);
    await ask(page, "Can I get a quote?");
    await chat(page).locator(".cta", { hasText: "Get a quote" }).click();
    const form = chat(page).locator("form.lead");
    await form.locator("input[type=email]").fill("ana@clinic.example");
    await form.locator("input[type=checkbox]").first().check();
    await form.locator("button[type=submit]").click();
    await chat(page).locator(".notice").waitFor();
    const lead = site.recorded.leads[0]!;
    assert.equal(lead.placement, "cta");
    assert.equal(lead.cta_label, "Get a quote");
    assert.equal(lead.consent_text, "I agree to be contacted about my request.");
    assert.equal(lead.language, "en");
    assert.deepEqual(lead.attribution, {
      landingPage: `${site.origin}/page`,
      utm_source: "linkedin",
      utm_campaign: "q4",
      gclid: "Cj0KCQ",
    });
    assert.doesNotMatch(JSON.stringify(lead), /x@y\.z/);
    await context.close();
  });

  it("carries the consent wording in the visitor's language", async () => {
    site.recorded.leads.length = 0;
    const { page, context } = await open("/page?mode=chat&lang=es");
    await rendered(page);
    await ask(page, "¿Venden bicicletas?");
    await chat(page).locator(".handoff button").click();
    const form = chat(page).locator("form.lead");
    await form.locator("input[type=email]").fill("ana@clinic.example");
    await form.locator("input[type=checkbox]").first().check();
    await form.locator("button[type=submit]").click();
    await chat(page).locator(".notice").waitFor();
    const lead = site.recorded.leads[0]!;
    assert.equal(lead.language, "es");
    assert.equal(lead.placement, "no-answer");
    assert.match(String(lead.consent_text), /^Acepto/);
    await context.close();
  });
});

describe("the chat header", () => {
  const phone = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
  const SIZES = [
    [1280, 800],
    [390, 844],
  ] as const;

  async function openChat(path: string, width: number, height: number) {
    const context = await browser.newContext(width < 480 ? phone : { viewport: { width, height } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await page.goto(`${site.origin}${path}`);
    await rendered(page);
    await chat(page).locator(".launcher").click();
    await chat(page)
      .locator(".header img")
      .evaluate((img: HTMLImageElement) => img.decode().catch(() => undefined));
    return { page, context, errors };
  }

  // Where each part of the header is, and whether the name shows in full.
  const layout = (page: Page) =>
    chat(page)
      .locator(".header")
      .evaluate((header) => {
        const box = (s: string) => {
          const r = (s === ":scope" ? header : header.querySelector(s))?.getBoundingClientRect();
          return r && { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width };
        };
        const name = header.querySelector<HTMLElement>(".name")!;
        return {
          compact: header.classList.contains("compact"),
          header: box(":scope")!,
          avatar: box(".avatar"),
          name: box(".name")!,
          nameText: name.textContent,
          nameWhole: name.scrollWidth <= name.clientWidth,
          nameFontPx: Number.parseFloat(getComputedStyle(name).fontSize),
          talk: box(".talk")!,
          close: box(".close")!,
        };
      });
  type Box = { left: number; right: number; top: number; bottom: number };
  const apart = (a: Box, b: Box) =>
    a.right <= b.left + 0.5 || b.right <= a.left + 0.5 || a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5;
  const inside = (a: Box, b: Box) => a.left >= b.left - 0.5 && a.right <= b.right + 0.5;

  for (const [language, label] of [
    ["en", "Talk to a person"],
    ["de", "Mit einer Person sprechen"],
  ] as const) {
    for (const [width, height] of SIZES) {
      it(`shows "WhatsUp Gold" whole beside its wide logo and a named "${label}" button, at ${width} px`, async () => {
        const { page, context, errors } = await openChat(`/page?mode=floating&dep=floating-wide&lang=${language}`, width, height);
        const l = await layout(page);
        assert.equal(l.nameText, "WhatsUp Gold");
        assert.ok(l.nameWhole, "the name isn't cut");
        assert.ok(l.avatar && l.avatar.width >= 95, `the logo keeps its width: ${l.avatar?.width}`);
        for (const [what, box] of [
          ["logo", l.avatar!],
          ["name", l.name],
        ] as const) {
          assert.ok(apart(box, l.talk), `${what} and the button apart: ${JSON.stringify([box, l.talk])}`);
          assert.ok(inside(box, l.header), `${what} inside the header`);
        }
        assert.ok(apart(l.talk, l.close) && inside(l.close, l.header), "the button and Close apart, Close inside");
        // Short of room, the button is its icon: named by its label, which shows as a tooltip.
        assert.ok(l.compact, "compact beside a 96 px logo");
        const talk = chat(page).getByRole("button", { name: label });
        assert.ok(await talk.isVisible());
        assert.ok(l.talk.right - l.talk.left >= 24, "an easy target (WCAG 2.5.8)");
        const tip = () => talk.evaluate((b) => [getComputedStyle(b, "::after").visibility, getComputedStyle(b, "::after").content]);
        assert.deepEqual(await tip(), ["hidden", `"${label}"`]);
        // With the mouse on a desktop; from the keyboard on the phone, where nothing hovers.
        if (width > 480) await talk.hover();
        else for (let i = 0; i < 12 && !(await talk.evaluate((b) => b.matches(":focus"))); i++) await page.keyboard.press("Shift+Tab");
        assert.deepEqual(await tip(), ["visible", `"${label}"`]);
        assert.deepEqual(errors, []);
        await context.close();
      });
    }
  }

  it("keeps the label beside a square logo and a name that fit, and drops it when the window narrows", async () => {
    const { page, context } = await openChat("/page?mode=floating&dep=floating-square&lang=en", 1280, 800);
    const l = await layout(page);
    assert.equal(l.compact, false);
    assert.ok(l.nameWhole && apart(l.name, l.talk) && apart(l.talk, l.close));
    assert.ok(await chat(page).locator(".talk-label").isVisible(), "the label shows");
    await context.close();
    // The Chat layout is as wide as the page: narrower, the header refits.
    const inPage = await open("/page?mode=chat&dep=chat-square&lang=en");
    await rendered(inPage.page);
    assert.equal(await layout(inPage.page).then((x) => x.compact), false);
    await inPage.page.setViewportSize({ width: 300, height: 800 });
    await inPage.page.waitForFunction(() => document.querySelector("arag-chat")?.shadowRoot?.querySelector(".header.compact"));
    const narrow = await layout(inPage.page);
    assert.ok(narrow.nameWhole && apart(narrow.name, narrow.talk));
    await inPage.page.setViewportSize({ width: 1280, height: 800 });
    await inPage.page.waitForFunction(() => document.querySelector("arag-chat")?.shadowRoot?.querySelector(".header:not(.compact)"));
    await inPage.context.close();
  });

  it("never lets the name and the button meet, in any language the widget speaks, at 1280 and 390 px", async () => {
    for (const { code } of LANGUAGES) {
      for (const [width, height] of SIZES) {
        const { page, context } = await openChat(`/page?mode=floating&dep=floating-wide&lang=${code}`, width, height);
        const l = await layout(page);
        assert.ok(l.nameWhole, `${code} ${width}: name whole`);
        assert.ok(apart(l.name, l.talk) && apart(l.avatar!, l.talk) && apart(l.talk, l.close), `${code} ${width}: apart`);
        assert.equal(
          await chat(page)
            .getByRole("button", { name: widgetStrings(code).talkToPerson })
            .count(),
          1,
          `${code}: named`,
        );
        await context.close();
      }
    }
  });

  it("cuts a name too long for any header with an ellipsis, after a few letters", async () => {
    for (const [width, height] of SIZES) {
      const { page, context } = await openChat("/page?mode=floating&dep=floating-long", width, height);
      const l = await layout(page);
      assert.equal(l.nameWhole, false);
      assert.ok(l.name.width >= 4 * l.nameFontPx - 1, `at least 4em: ${l.name.width}`);
      assert.equal(
        await chat(page)
          .locator(".name")
          .evaluate((n) => getComputedStyle(n).textOverflow),
        "ellipsis",
      );
      assert.ok(apart(l.name, l.talk) && apart(l.talk, l.close) && inside(l.close, l.header), `${width}: apart`);
      await context.close();
    }
  });

  it("lays out the console's still of the header exactly as the open chat", async () => {
    for (const [width, height, device] of [
      [1280, 800, "desktop"],
      [390, 844, "phone"],
    ] as const) {
      const live = await openChat("/page?mode=floating&dep=floating-wide&lang=de", width, height);
      const real = await layout(live.page);
      await live.context.close();
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await context.newPage();
      await page.goto(`${site.origin}/still`);
      const still = await page.evaluate(
        async ({ url, device }) => {
          await customElements.whenDefined("arag-chat");
          const config = await (await fetch(url)).json();
          const el = document.createElement("arag-chat") as HTMLElement & { preview: (c: unknown, o: unknown) => void };
          el.setAttribute("language", "de");
          document.body.append(el);
          el.preview(config, { snapshot: "header", device, fetchToken: () => Promise.reject(new Error("a still")) });
          // Set through the CSSOM: the page's policy allows no inline styles.
          el.style.width = device === "phone" ? "390px" : "380px";
          await el
            .shadowRoot!.querySelector("img")
            ?.decode()
            .catch(() => undefined);
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          const header = el.shadowRoot!.querySelector<HTMLElement>(".header")!;
          const panel = el.shadowRoot!.querySelector<HTMLElement>(".panel")!;
          const left = header.getBoundingClientRect().left;
          const at = (s: string) => {
            const r = header.querySelector(s)!.getBoundingClientRect();
            return [Math.round(r.left - left), Math.round(r.width)];
          };
          return {
            compact: header.classList.contains("compact"),
            width: Math.round(header.getBoundingClientRect().width),
            parts: [at(".avatar"), at(".name"), at(".talk"), at(".close")],
            log: getComputedStyle(panel.querySelector(".log")!).display,
            inert: panel.inert,
          };
        },
        { url: `${site.origin}/api/public/deployments/e2e-floating-wide/config`, device },
      );
      const left = real.header.left;
      const at = (b: { left: number; width: number }) => [Math.round(b.left - left), Math.round(b.width)];
      assert.equal(still.compact, real.compact, device);
      assert.equal(still.width, Math.round(real.header.right - real.header.left), `${device}: header width`);
      assert.deepEqual(still.parts, [at(real.avatar!), at(real.name), at(real.talk), at(real.close)], device);
      assert.equal(still.log, "none", "the header alone");
      assert.equal(still.inert, true);
      await context.close();
    }
  });
});

describe("Resume reaches a chat that's already open", () => {
  it("brings back the question box and the conversation without a reload", async () => {
    site.recorded.paused = false;
    const context = await browser.newContext();
    await context.addInitScript(() => {
      const real = Date.now.bind(Date);
      Date.now = () => real() + ((globalThis as { skew?: number }).skew ?? 0);
    });
    const page = await context.newPage();
    await page.goto(`${site.origin}/page?mode=floating`);
    await rendered(page);
    await chat(page).locator(".launcher").click();
    await ask(page, "When are you open?");
    site.recorded.paused = true;
    await page.evaluate(() => {
      (globalThis as { skew?: number }).skew = 31_000;
    });
    await chat(page).locator("textarea").fill("Do you take new patients?");
    await chat(page).locator("textarea").press("Enter");
    await chat(page).getByText("Chat is unavailable right now.").waitFor();
    site.recorded.paused = false;
    await page.evaluate(() => {
      (globalThis as { skew?: number }).skew = 40_000;
    });
    // Closing and opening the chat asks the console again.
    await chat(page).locator(".close").click();
    await chat(page).locator(".launcher").click();
    await chat(page).locator("textarea").waitFor();
    assert.equal(await chat(page).locator(".message.user").first().textContent(), "When are you open?");
    assert.equal(await chat(page).getByText("Chat is unavailable right now.").count(), 0);
    await context.close();
  });
});

describe("asking a KB that holds pages in several languages", () => {
  it("asks an English question of the English pages, with the conversation", async () => {
    const { page, context } = await open("/page?mode=chat&dep=chat-multi");
    await rendered(page);
    const before = site.recorded.asks.length;
    await ask(page, "When are you open?");
    const asks = site.recorded.asks.slice(before);
    assert.equal(asks.length, 1, "answered the first time");
    assert.deepEqual(asks[0]!.filter_expression, { field: { prop: "language", language: "en", only_primary: true } });
    assert.deepEqual(asks[0]!.chat_history, []);
    await context.close();
  });

  it("asks a follow-up with no answer once more, of every page and without the conversation", async () => {
    const { page, context } = await open("/page?mode=chat&dep=chat-multi");
    await rendered(page);
    await ask(page, "When are you open?");
    const before = site.recorded.asks.length;
    await ask(page, "Is there a warranty?");
    const asks = site.recorded.asks.slice(before);
    assert.equal(asks.length, 2);
    assert.ok(
      asks[0]!.filter_expression && (asks[0]!.chat_history as unknown[]).length === 2,
      "first: English pages, with the conversation",
    );
    assert.equal(asks[1]!.filter_expression, undefined, "then every page");
    assert.deepEqual(asks[1]!.chat_history, [], "and no conversation");
    const reply = chat(page).locator(".message.assistant").last();
    assert.equal(await reply.locator(".answer strong").textContent(), "Monday to Friday", "the second reply is shown");
    assert.equal(await reply.locator(".sources").count(), 1);
    assert.equal(await reply.locator(".handoff").count(), 0);
    await context.close();
  });

  it("asks a deployment with pages in one language just once, as before", async () => {
    const { page, context } = await open("/page?mode=chat");
    await rendered(page);
    const before = site.recorded.asks.length;
    await ask(page, "Do you sell bicycles?");
    const asks = site.recorded.asks.slice(before);
    assert.equal(asks.length, 1, "no filter and no conversation to drop: nothing to ask differently");
    assert.equal(asks[0]!.filter_expression, undefined);
    await context.close();
  });
});

describe("counting a question once", () => {
  it("tells the console how many asks an answer took and on which origin, and the page nothing of it", async () => {
    site.recorded.events.length = 0;
    const { page, context } = await open("/page?mode=chat&dep=chat-multi");
    await rendered(page);
    await page.evaluate(() => {
      const seen: unknown[] = [];
      (window as unknown as { seen: unknown[] }).seen = seen;
      document.addEventListener("arag-chat:event", (e) => seen.push((e as CustomEvent).detail));
    });
    await ask(page, "When are you open?");
    await ask(page, "Is there a warranty?");
    const dom = await page.evaluate(() => (window as unknown as { seen: Record<string, unknown>[] }).seen);
    await page.goto("about:blank"); // pagehide: the events go with the beacon
    await new Promise((r) => setTimeout(r, 500));
    const answers = site.recorded.events.filter((e) => e.name === "arag_chat_answer");
    assert.deepEqual(
      answers.map((e) => [e.attempts, e.origin]),
      [
        [1, site.origin],
        [2, site.origin],
      ],
      "the follow-up was asked again",
    );
    const shown = dom.filter((d) => d.name === "arag_chat_answer");
    assert.equal(shown.length, 2);
    for (const d of shown) assert.ok(!("attempts" in d || "origin" in d || "question_hash" in d), JSON.stringify(d));
    await context.close();
  });
});

describe("a domain Agentic RAG hasn't applied yet", () => {
  it('says "Almost ready" in the visitor\'s language rather than "Something went wrong", then answers once it applies', async () => {
    site.recorded.lockPending = true;
    const { page, context } = await open("/page?mode=chat&dep=chat-locked&csp=none&lang=es");
    await rendered(page);
    await chat(page).locator("textarea").fill("¿Cuándo abren?");
    await chat(page).locator("textarea").press("Enter");
    await chat(page).locator(".retry").waitFor();
    const reply = chat(page).locator(".message.assistant").last();
    assert.equal(await reply.locator(".answer").textContent(), widgetStrings("es").almostReady);
    assert.equal(await reply.locator(".retry").textContent(), widgetStrings("es").retry);
    site.recorded.lockPending = false;
    await chat(page).locator(".retry").click();
    await lastReplyDone(page);
    assert.equal(await chat(page).locator(".message.assistant").last().locator(".answer strong").textContent(), "Monday to Friday");
    assert.equal(await chat(page).locator(".message.user").count(), 1);
    await context.close();
  });

  it("still says something went wrong when Agentic RAG can't be reached at all", async () => {
    const { page, context } = await open("/page?mode=chat&dep=chat-locked&lang=es");
    await rendered(page);
    // The page's own policy blocks the other origin: that's no domain lock.
    await chat(page).locator("textarea").fill("¿Cuándo abren?");
    await chat(page).locator("textarea").press("Enter");
    await chat(page).locator(".retry").waitFor();
    assert.equal(await chat(page).locator(".message.assistant .answer").last().textContent(), widgetStrings("es").failed);
    await context.close();
  });
});

describe("an honest verdict in the chat (round 4)", () => {
  const dataLayer = (page: Page) =>
    page.evaluate(() =>
      ((window as unknown as { dataLayer: Record<string, unknown>[] }).dataLayer ?? []).filter((e) => e.event === "arag_chat_answer"),
    );

  it("puts the handoff card under a reworded no-answer, keeps its words, and tells the dataLayer answered:false (crayola.com's slime)", async () => {
    const { page, context } = await open("/page?mode=chat&dep=chat-ga&ga=1");
    await rendered(page);
    await ask(page, "How do I get slime out of carpet?");
    const reply = chat(page).locator(".message.assistant").last();
    assert.match((await reply.locator(".answer").textContent()) ?? "", /we don.t have a carpet-specific removal method listed/);
    assert.equal(await reply.locator(".handoff").count(), 1);
    assert.equal(await reply.locator(".sources").count(), 0);
    assert.equal(await reply.locator(".thumb").count(), 0);
    assert.deepEqual(
      (await dataLayer(page)).map((e) => e.answered),
      [false],
    );
    await context.close();
  });

  it('puts it under "Contact Support." too: an answer to check that sends the visitor to the team (telerik.com)', async () => {
    const { page, context } = await open("/page?mode=chat&dep=chat-ga&ga=1");
    await rendered(page);
    await ask(page, "How do I contact support?");
    const reply = chat(page).locator(".message.assistant").last();
    assert.equal((await reply.locator(".answer").textContent())?.trim(), "Contact Support.");
    assert.equal(await reply.locator(".handoff").count(), 1);
    assert.equal(await reply.locator(".sources").count(), 0, "the React pages cited for a footer link don't fit");
    assert.deepEqual(
      (await dataLayer(page)).map((e) => e.answered),
      [false],
      "a deflection (round 6): a gap, with the card",
    );
    await context.close();
  });

  it("puts it under a reply that sends the visitor to the team with no way to reach it (the demo's partner question)", async () => {
    const { page, context } = await open("/page?mode=chat");
    await rendered(page);
    await ask(page, "Who should I talk to about becoming a partner?");
    const reply = chat(page).locator(".message.assistant").last();
    assert.equal((await reply.locator(".answer").textContent())?.trim(), "Contact us to discuss becoming a partner.");
    assert.equal(await reply.locator(".handoff .contact").count(), 1);
    assert.equal(await reply.locator(".sources a").count(), 0, "a deflection (round 6): the card, not sources");
    await context.close();
  });

  it("puts no card under an answer that names the contact page itself (whatsupgold.com, round 5)", async () => {
    const { page, context } = await open("/page?mode=chat&dep=chat-ga&ga=1");
    await rendered(page);
    await ask(page, "How do I contact sales?");
    const reply = chat(page).locator(".message.assistant").last();
    assert.match((await reply.locator(".answer").textContent()) ?? "", /contact form on our Contact Us page/);
    assert.equal(await reply.locator(".handoff").count(), 0);
    assert.deepEqual(await reply.locator(".sources a").evaluateAll((links) => links.map((a) => a.firstChild?.textContent)), ["Contact Us"]);
    assert.deepEqual(
      (await dataLayer(page)).map((e) => e.answered),
      [true],
    );
    await context.close();
  });

  it("doesn't offer the team twice: no card under a reply that already has a quote button", async () => {
    const { page, context } = await open("/page?mode=chat");
    await rendered(page);
    await ask(page, "Can I get a quote for slime removal?");
    const reply = chat(page).locator(".message.assistant").last();
    assert.equal(await reply.locator(".cta").textContent(), "Get a quote");
    assert.equal(await reply.locator(".handoff").count(), 0);
    await context.close();
  });

  it("shows at most two sources, and none cited only for a band every page repeats", async () => {
    const { page, context } = await open("/page?mode=chat");
    await rendered(page);
    await ask(page, "What are your opening hours and prices?");
    const reply = chat(page).locator(".message.assistant").last();
    const titles = await reply.locator(".sources a").evaluateAll((links) => links.map((a) => a.firstChild?.textContent));
    assert.deepEqual(titles, ["Opening hours", "Partner clinic opening hours"]);
    await context.close();
  });
});

describe("the question event (round 4: test questions counted as the client's)", () => {
  it("tells the console where a question was asked as it's asked, so a tab closed a second after the answer still counts as test traffic", async () => {
    site.recorded.questions.length = 0;
    site.recorded.events.length = 0;
    const { page, context } = await open("/page?mode=chat");
    await rendered(page);
    await ask(page, "When are you open?");
    await page.waitForTimeout(1000);
    await page.close();
    await new Promise((r) => setTimeout(r, 300));
    const sent = site.recorded.questions.filter((q) => q.questionHash === questionHash("When are you open?"));
    assert.ok(sent.length >= 1, "the question event arrived");
    assert.equal(sent[0]?.origin, site.origin, "with the page's origin, as the browser sent it");
    assert.match(sent[0]?.contentType ?? "", /^text\/plain/, "a simple request: no preflight");
    assert.ok(sent[0]?.conversationId);
    assert.ok(!site.recorded.events.some((e) => e.name === "arag_chat_question" && "question" in e), "no text anywhere");
    await context.close();
  });

  it("goes again with the beacon on pagehide while its post is still in flight", async () => {
    site.recorded.questions.length = 0;
    site.recorded.holdQuestions = true;
    try {
      const { page, context } = await open("/page?mode=chat");
      await rendered(page);
      await ask(page, "Do you take new patients?");
      await page.goto("about:blank"); // pagehide
      await new Promise((r) => setTimeout(r, 500));
      const sent = site.recorded.questions.filter((q) => q.questionHash === questionHash("Do you take new patients?"));
      assert.equal(sent.length, 2, "the post, then the beacon; the console keeps one row");
      assert.equal(new Set(sent.map((q) => q.conversationId)).size, 1);
      await context.close();
    } finally {
      site.recorded.holdQuestions = false;
    }
  });
});

describe("round 5: grounding and intent routing in the chat", () => {
  it("shows kemptechnologies.com's cited prices, which the old score floor hid (its raw Agentic RAG stream)", async () => {
    const { page, context } = await open("/page?mode=chat");
    await rendered(page);
    await ask(page, "What are your prices?");
    const reply = chat(page).locator(".message.assistant").last();
    const text = (await reply.locator(".answer").textContent()) ?? "";
    for (const figure of ["$2,205 per year", "$4,500", "$5,300", "$6,200", "$0.41/hour"]) assert.ok(text.includes(figure), figure);
    assert.ok(!text.includes(widgetStrings("en").noAnswer), "not the no-answer reply");
    assert.equal(await reply.locator(".handoff").count(), 0, "an answer, so no handoff card");
    assert.ok((await reply.locator(".sources a").count()) >= 1, "with its sources");
    await context.close();
  });

  it("asks a price question with the price configuration, of the price pages in the visitor's language", async () => {
    const { page, context } = await open("/page?mode=chat&dep=chat-routed");
    await rendered(page);
    const before = site.recorded.asks.length;
    await ask(page, "What does Gold cost?");
    const asks = site.recorded.asks.slice(before);
    assert.equal(asks.length, 1, "answered from the price pages, the first time");
    assert.equal(asks[0]!.search_configuration, ROUTED.price);
    assert.deepEqual(asks[0]!.filter_expression, {
      field: {
        and: [
          { prop: "language", language: "en", only_primary: true },
          {
            or: [
              { prop: "label", labelset: "launchpad_page", label: "price" },
              { prop: "label", labelset: "launchpad_page", label: "buy" },
              { prop: "resource", id: UNLABELLED_PAGE },
            ],
          },
        ],
      },
    });
    const reply = chat(page).locator(".message.assistant").last();
    assert.match((await reply.locator(".answer").textContent()) ?? "", /\$59 per node, per year/);
    assert.equal(await reply.locator(".handoff").count(), 0);
    await context.close();
  });

  it("falls back to the deployment's own configuration when the price pages have no answer", async () => {
    const { page, context } = await open("/page?mode=chat&dep=chat-routed");
    await rendered(page);
    const before = site.recorded.asks.length;
    await ask(page, "How much is Platinum?");
    const asks = site.recorded.asks.slice(before);
    assert.equal(asks.length, 2);
    assert.equal(asks[0]!.search_configuration, ROUTED.price, "first: the price configuration");
    assert.equal(asks[1]!.search_configuration, undefined, "then the deployment's own");
    assert.deepEqual(
      asks[1]!.filter_expression,
      { field: { prop: "language", language: "en", only_primary: true } },
      "still the visitor's language",
    );
    assert.deepEqual(asks[1]!.chat_history, []);
    assert.match((await chat(page).locator(".message.assistant").last().locator(".answer").textContent()) ?? "", /\$189 per node/);
    await context.close();
  });

  it("answers from the deployment's own configuration when an intent's isn't saved on the KB yet", async () => {
    const { page, context } = await open("/page?mode=chat&dep=chat-routed");
    await rendered(page);
    const before = site.recorded.asks.length;
    await ask(page, "When is the next webinar?");
    const asks = site.recorded.asks.slice(before);
    assert.deepEqual(
      asks.map((a) => a.search_configuration),
      [ROUTED.events, undefined],
    );
    const reply = chat(page).locator(".message.assistant").last();
    assert.match((await reply.locator(".answer").textContent()) ?? "", /Thursday, November 5, 2026/);
    assert.equal(await reply.locator(".retry").count(), 0, "no “Something went wrong”");
    await context.close();
  });

  it("asks a question with no intent as before, and an unrouted deployment never names a configuration", async () => {
    const routed = await open("/page?mode=chat&dep=chat-routed");
    await rendered(routed.page);
    let before = site.recorded.asks.length;
    await ask(routed.page, "Do you take new patients?");
    assert.deepEqual(
      site.recorded.asks.slice(before).map((a) => [a.search_configuration, a.filter_expression]),
      [[undefined, { field: { prop: "language", language: "en", only_primary: true } }]],
    );
    await routed.context.close();
    const plain = await open("/page?mode=chat");
    await rendered(plain.page);
    before = site.recorded.asks.length;
    await ask(plain.page, "What does Gold cost?");
    const asks = site.recorded.asks.slice(before);
    assert.ok(asks.every((a) => a.search_configuration === undefined));
    await plain.context.close();
  });
});

describe("round 6: the visitor's language on every ask of a market's facts", () => {
  const german = { field: { prop: "language", language: "de", only_primary: true } };

  it("keeps a German price question on the German pages, routed and on the second ask", async () => {
    const { page, context } = await open("/page?mode=chat&dep=chat-routed");
    await rendered(page);
    const before = site.recorded.asks.length;
    await ask(page, "Was kostet Platinum?");
    const asks = site.recorded.asks.slice(before);
    assert.equal(asks.length, 2);
    const first = asks[0]!.filter_expression as { field: { and: unknown[] } };
    assert.deepEqual(first.field.and[0], german.field, "routed, and joined with the language filter");
    assert.equal(asks[0]!.search_configuration, ROUTED.price);
    assert.deepEqual(asks[1]!.filter_expression, german, "the fallback stays German");
    await context.close();
  });

  it("keeps a German phone question on the German pages, and asks other questions of every page the second time", async () => {
    const { page, context } = await open("/page?mode=chat&dep=chat-multi");
    await rendered(page);
    let before = site.recorded.asks.length;
    await ask(page, "Wie lautet Ihre Telefonnummer? Was ist die Garantie, warranty?");
    let asks = site.recorded.asks.slice(before);
    assert.ok(asks.length >= 1 && asks.every((a) => JSON.stringify(a.filter_expression) === JSON.stringify(german)), JSON.stringify(asks));
    before = site.recorded.asks.length;
    await ask(page, "Is there a warranty?");
    asks = site.recorded.asks.slice(before);
    assert.equal(asks.length, 2);
    assert.equal(asks[1]!.filter_expression, undefined, "a question with no market in it: every page");
    await context.close();
  });
});

describe("round 6 re-check: an account blocked for budget, and a stream that stalls", () => {
  it("says the chat's offline message when Agentic RAG refuses with 402, and tells the console", async () => {
    site.recorded.events.length = 0;
    const { page, context } = await open("/page?mode=chat");
    await rendered(page);
    await chat(page).locator("textarea").fill("Is there a budget block?");
    await chat(page).locator("textarea").press("Enter");
    await chat(page).getByText(widgetStrings("en").offline).waitFor({ timeout: 10_000 });
    assert.equal(await chat(page).getByText(widgetStrings("en").failed).count(), 0, "not “Something went wrong”");
    await page.goto("about:blank");
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(
      site.recorded.events.some((e) => e.name === "arag_chat_answer" && e.blocked === true),
      JSON.stringify(site.recorded.events),
    );
    await context.close();
  });

  it("cuts a stream that goes quiet and offers Try again", async () => {
    const { page, context } = await open("/page?mode=chat");
    await rendered(page);
    await chat(page).locator("textarea").fill("This answer stalls");
    await chat(page).locator("textarea").press("Enter");
    const retry = chat(page).locator(".message.assistant").last().locator(".retry");
    await retry.waitFor({ timeout: 30_000 });
    assert.equal(await chat(page).locator(".message.assistant").last().getAttribute("aria-busy"), null);
    await context.close();
  });
});

describe("round 6: price answers checked against the confirmed table, and links only to synced pages", () => {
  // Every text the answer showed while it streamed, from inside the shadow root.
  const watchAnswers = (page: Page) =>
    page.evaluate(() => {
      const root = document.querySelector("arag-chat")?.shadowRoot;
      const seen: string[] = [];
      (window as unknown as { seen: string[] }).seen = seen;
      new MutationObserver(() => {
        for (const a of root?.querySelectorAll(".answer") ?? []) seen.push(a.textContent ?? "");
      }).observe(root as ShadowRoot, { subtree: true, childList: true, characterData: true });
    });

  it("holds a price answer, and replaces a blog's figure for a table plan with the confirmed row, the pricing page and its button", async () => {
    const { page, context } = await open("/page?mode=chat&dep=chat-priced");
    await rendered(page);
    await watchAnswers(page);
    await ask(page, "How much is the Gold plan?");
    const reply = chat(page).locator(".message.assistant").last();
    const text = (await reply.locator(".answer").textContent()) ?? "";
    assert.match(text, /The prices on our pricing page:\s*Gold: \$59 per node per year/);
    assert.ok(!text.includes("Platinum"), "only the plan asked about");
    const seen = await page.evaluate(() => (window as unknown as { seen: string[] }).seen);
    assert.ok(!seen.some((t) => t.includes("$99")), "the contradicting text never showed, even while it streamed");
    assert.deepEqual(await reply.locator(".sources a").evaluateAll((links) => links.map((a) => (a as HTMLAnchorElement).pathname)), [
      "/pricing",
    ]);
    assert.deepEqual(await reply.locator(".ctas a").evaluateAll((links) => links.map((a) => a.textContent)), ["See pricing"]);
    assert.equal(await reply.locator(".handoff").count(), 0);
    await context.close();
  });

  it("shows a price answer that matches the table as written", async () => {
    const { page, context } = await open("/page?mode=chat&dep=chat-priced");
    await rendered(page);
    await ask(page, "How much is Platinum?");
    const reply = chat(page).locator(".message.assistant").last();
    assert.equal((await reply.locator(".answer").textContent())?.trim(), "Platinum costs $189 per node, per year.");
    await context.close();
  });

  it("says it's checking the prices while a price reply is held, once to a screen reader (build 8)", async () => {
    site.recorded.slowAsk = 2500;
    try {
      const { page, context } = await open("/page?mode=chat&dep=chat-priced");
      await rendered(page);
      await chat(page).locator("textarea").fill("How much is Platinum?");
      await chat(page).locator("textarea").press("Enter");
      const reply = chat(page).locator(".message.assistant").last();
      await reply.locator("text=Checking our prices…").waitFor({ timeout: 2500 });
      await chat(page)
        .locator(".sr-only[aria-live]", { hasText: widgetStrings("en").checkingPrices })
        .waitFor({ state: "attached" });
      await lastReplyDone(page);
      assert.equal((await reply.locator(".answer").textContent())?.trim(), "Platinum costs $189 per node, per year.");
      await context.close();
    } finally {
      site.recorded.slowAsk = 0;
    }
  });

  it("links a page name to the cited page, never to an unsynced page or javascript:", async () => {
    const { page, context } = await open("/page?mode=chat&dep=chat-priced");
    await rendered(page);
    await watchAnswers(page);
    await ask(page, "Can I book a demo?");
    const reply = chat(page).locator(".message.assistant").last();
    const answer = reply.locator(".answer");
    assert.equal((await answer.textContent())?.trim(), "Yes: Request a Demo, or try Interactive demos. Click here.");
    assert.deepEqual(
      await answer.locator("a").evaluateAll((links) => links.map((a) => [a.textContent, (a as HTMLAnchorElement).pathname])),
      [["Request a Demo", "/request-a-demo"]],
    );
    const seen = await page.evaluate(() => (window as unknown as { seen: string[] }).seen);
    assert.ok(!seen.some((t) => /[[\]]|\]\(/.test(t)), "no bracket syntax, even while streaming");
    await context.close();
  });
});

describe("build 8: events in every language, the form on contact questions, no stuck bubble", () => {
  it("asks 'wann ist…' of the events pages, on a site with events", async () => {
    const { page, context } = await open("/page?mode=chat&dep=chat-eventful");
    await rendered(page);
    const before = site.recorded.asks.length;
    await ask(page, "Wann ist das Seminar?");
    const asks = site.recorded.asks.slice(before);
    assert.equal(asks[0]!.search_configuration, EVENTFUL);
    const reply = chat(page).locator(".message.assistant").last();
    assert.match((await reply.locator(".answer").textContent()) ?? "", /5\. November 2026/);
    assert.equal(await reply.locator(".handoff").count(), 0, "it names the day, so no card");
    await context.close();
  });

  it("gives the card under a reply that cites a page with stored dates and names no day", async () => {
    const { page, context } = await open("/page?mode=chat&dep=chat-eventful");
    await rendered(page);
    await ask(page, "Wann findet das Webinar statt?");
    const reply = chat(page).locator(".message.assistant").last();
    assert.equal(await reply.locator(".handoff").count(), 1);
    await context.close();
  });

  it("asks an events question of every language the second time", async () => {
    const { page, context } = await open("/page?mode=chat&dep=chat-eventful");
    await rendered(page);
    const before = site.recorded.asks.length;
    await ask(page, "¿Hay algún webinar próximo?");
    const asks = site.recorded.asks.slice(before);
    assert.equal(asks.length, 2);
    assert.ok(asks[0]!.filter_expression, "first in the visitor's language");
    assert.equal(asks[1]!.filter_expression, undefined, "then of every page");
    const reply = chat(page).locator(".message.assistant").last();
    assert.match((await reply.locator(".answer").textContent()) ?? "", /5 de noviembre/);
    assert.equal(await reply.locator(".handoff").count(), 0);
    await context.close();
  });

  it("offers the form on a contact or callback question, once, whatever the reply says", async () => {
    const { page, context } = await open("/page?mode=chat");
    await rendered(page);
    for (const q of ["Can someone call me back?", "How do I contact sales?", "Who should I talk to about becoming a partner?"]) {
      await ask(page, q);
      const reply = chat(page).locator(".message.assistant").last();
      assert.equal(await reply.locator("[part=lead-button]").count(), 1, q);
    }
    await chat(page).locator(".message.assistant").last().locator("[part=lead-button]").click();
    await chat(page).locator("form.lead").waitFor();
    await context.close();
  });

  it("doesn't offer it under an ordinary answer", async () => {
    const { page, context } = await open("/page?mode=chat");
    await rendered(page);
    await ask(page, "What are your hours?");
    assert.equal(await chat(page).locator(".message.assistant").last().locator("[part=lead-button]").count(), 0);
    await context.close();
  });

  it("a question sent while one is waiting leaves no empty bubble", async () => {
    const { page, context } = await open("/page?mode=chat");
    await rendered(page);
    const box = chat(page).locator("textarea");
    await box.fill("This one stalls");
    await box.press("Enter");
    await chat(page).locator(".cursor").waitFor();
    await page.evaluate(() => {
      const root = document.querySelector("arag-chat")!.shadowRoot!;
      const text = root.querySelector("textarea")!;
      text.value = "What are your hours?";
      root.querySelector("form")!.requestSubmit();
    });
    await lastReplyDone(page);
    assert.equal(await chat(page).locator(".message.assistant .answer").count(), 1);
    assert.equal(await chat(page).locator(".message.user").count(), 1);
    assert.equal(await chat(page).locator(".cursor").count(), 0);
    await context.close();
  });

  it("has a generic family to fall back on, where the client's web font doesn't load", async () => {
    const family = resolveTheme({ font: { family: '"Noto Sans"' } }).theme.font.family;
    assert.equal(family, '"Noto Sans", system-ui, -apple-system, "Segoe UI", sans-serif');
    assert.equal(resolveTheme({ font: { family } }).theme.font.family, family, "resolved twice, it's the same");
  });
});
