// extractStyles and measureIcons in a real browser, on made-up sites served from memory: the
// contact page linked from a site's header or footer, in several languages, and the icons'
// own sizes, including a /favicon.ico the page never links.
//   npx playwright install chromium && npm run test:browser --workspace @launchpad/sniffer

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { type Browser, chromium, type Page } from "playwright";
import { logoCandidates } from "../src/derive.ts";
import { extractStyles, measureIcons } from "../src/extract.ts";

// A plain square PNG of the given size.
function png(size: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, 0x5a)]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: size }, () => row)));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", pixels),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const page = (lang: string, head: string, header: string, footer: string, main = "") => `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><title>Acme</title>${head}</head><body>
<header><a href="/"><img src="/logo.png" alt="Acme" width="120" height="40"></a><nav>${header}</nav></header>
<main><h1>Acme</h1>${main}</main><footer>${footer}</footer></body></html>`;

// address → body
const SITES: Record<string, { type: string; body: string | Buffer }> = {
  "https://www.acme.example/": {
    type: "text/html",
    body: page(
      "en",
      '<link rel="icon" href="/favicon.ico"><link rel="apple-touch-icon" href="/apple-touch-icon.png">',
      '<a href="/products">Products</a><a href="/contact-us/request-a-demo">Request a demo</a><a href="https://partner.example/contact">Partner contact</a>',
      '<a href="/company/contact-us?utm_source=footer#form">Contact us</a><a href="/privacy">Privacy</a>',
      '<p>Questions? <a href="/blog/contact-center-trends">Contact center trends</a></p>',
    ),
  },
  "https://www.acme.example/de/": {
    type: "text/html",
    body: page(
      "de",
      "",
      '<a href="/de/produkte">Produkte</a><a href="/de/kontakt">Kontakt</a>',
      '<a href="/de/datenschutz">Datenschutz</a>',
    ),
  },
  "https://www.acme.example/ja/": {
    type: "text/html",
    body: page("ja", "", '<a href="/ja/products">製品</a>', '<a href="/ja/inquiry">お問い合わせ</a>'),
  },
  "https://www.acme.example/fr/": {
    type: "text/html",
    body: page("fr", "", '<a href="/fr/nous-contacter">Nous contacter</a>', ""),
  },
  "https://www.acme.example/cms/": {
    type: "text/html",
    body: page(
      "en",
      "",
      '<a href="/company/contact">Ready to talk?</a>',
      '<a href="/company/contact">Contact us</a>',
      '<section><a href="/cms/contact">Contact Sales</a><a href="/blog/contact-forms">Contact forms</a></section>',
    ),
  },
  "https://www.acme.example/none/": {
    type: "text/html",
    body: page(
      "en",
      "",
      '<a href="/about">About</a>',
      '<a href="mailto:hello@acme.example">Email us</a>',
      '<a href="/contact">Contact</a>',
    ),
  },
  "https://www.acme.example/favicon.ico": { type: "image/png", body: png(48) },
  "https://www.acme.example/apple-touch-icon.png": { type: "image/png", body: png(180) },
  "https://www.acme.example/logo.png": { type: "image/png", body: png(40) },
};

describe("the scan in a browser", () => {
  let browser: Browser;
  let tab: Page;
  before(async () => {
    browser = await chromium.launch();
    tab = await browser.newPage();
    await tab.route("**/*", (route) => {
      // The scanner asks for favicon.ico with a query string (measureIcons).
      const found =
        SITES[
          route
            .request()
            .url()
            .replace(/\?size$/, "")
        ];
      return found ? route.fulfill({ status: 200, contentType: found.type, body: found.body }) : route.fulfill({ status: 404, body: "" });
    });
  });
  after(async () => {
    await browser?.close();
  });

  const contact = async (url: string) => {
    await tab.goto(url);
    return (await tab.evaluate(extractStyles)).contact;
  };

  it("finds the contact page in the header or footer, plainest first, without tracking or fragments", async () => {
    assert.deepEqual(await contact("https://www.acme.example/"), {
      url: "https://www.acme.example/company/contact-us",
      text: "Contact us",
    });
  });

  it("reads contact words in the page's language", async () => {
    assert.equal((await contact("https://www.acme.example/de/"))?.url, "https://www.acme.example/de/kontakt");
    assert.equal((await contact("https://www.acme.example/ja/"))?.url, "https://www.acme.example/ja/inquiry");
    assert.equal((await contact("https://www.acme.example/fr/"))?.url, "https://www.acme.example/fr/nous-contacter");
  });

  it("prefers the contact page of the section the page is in, even linked from its content", async () => {
    assert.deepEqual(await contact("https://www.acme.example/cms/"), {
      url: "https://www.acme.example/cms/contact",
      text: "Contact Sales",
    });
  });

  it("takes no email address, other site or link from the page's content", async () => {
    assert.equal(await contact("https://www.acme.example/none/"), undefined);
  });

  it("measures the icons, and finds a /favicon.ico the page doesn't link", async () => {
    await tab.goto("https://www.acme.example/");
    const raw = await tab.evaluate(extractStyles);
    const icons = await tab.evaluate(measureIcons, raw.iconLinks ?? []);
    assert.deepEqual(
      icons.map((i) => [i.rel, i.width, i.height]),
      [
        ["icon", 48, 48],
        ["apple-touch-icon", 180, 180],
      ],
    );
    assert.deepEqual(
      logoCandidates({ ...raw, iconLinks: icons }).map((c) => [c.source, c.width]),
      [
        ["header-home", 120],
        ["apple-touch-icon", 180],
        ["icon", 48],
      ],
    );
    await tab.goto("https://www.acme.example/de/");
    assert.deepEqual(await tab.evaluate(measureIcons, []), [
      { url: "https://www.acme.example/favicon.ico", rel: "icon", width: 48, height: 48 },
    ]);
  });
});
