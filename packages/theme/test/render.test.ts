import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compactPagePaths, type LinkContext, linkFor, parseModelText, plainText, renderModelText } from "../src/render.ts";

// MOVEit's deployment, as the public config and the validation run see it.
const ctx: LinkContext = {
  pagePaths: ["/", "/pricing", "/request-a-demo", "/products/moveit-transfer", "/support/contact"],
  ctaTargets: ["https://www.progress.com/moveit/request-a-demo", "mailto:sales@progress.com", "https://calendly.com/progress/demo"],
  hosts: ["www.progress.com"],
  pages: [
    { title: "Request a Demo | MOVEit", href: "https://www.progress.com/request-a-demo" },
    { title: "MOVEit Transfer", href: "https://www.progress.com/products/moveit-transfer" },
  ],
};

const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
const visible = (html: string) => html.replace(/<[^>]+>/g, "");

// What must hold for every rendering: no Markdown link syntax on screen, and no unsafe link.
function assertSafe(html: string) {
  const text = visible(html);
  assert.ok(!/[[\]]/.test(text), `brackets on screen: ${text}`);
  assert.ok(!text.includes("]("), `"](" on screen: ${text}`);
  for (const href of hrefs(html)) assert.match(href ?? "", /^(https?:|mailto:|tel:)/, `unsafe href ${href}`);
  assert.ok(!/<(script|img|iframe|svg|style)/i.test(html), `markup from the model: ${html}`);
  assert.ok(!/<[^>]*\son\w+=/i.test(html), `event handler: ${html}`);
}

// [input, the visible text, the hrefs that may show]
const VARIANTS: [string, string, string[]][] = [
  // MOVEit, round 6: a target with spaces.
  ["[Request a Demo](Request a Demo)", "Request a Demo", ["https://www.progress.com/request-a-demo"]],
  ["You can [Request a Demo](Request a Demo) today.", "You can Request a Demo today.", ["https://www.progress.com/request-a-demo"]],
  ["[Book a call](Book a call)", "Book a call", []],
  ["[Request a Demo]( Request a Demo )", "Request a Demo", ["https://www.progress.com/request-a-demo"]],
  ["[Pricing](our pricing page)", "Pricing", ["https://www.progress.com/pricing"]],
  // Anchors and empty targets.
  ["[Contact us](#)", "Contact us", []],
  ["[Contact us](#contact)", "Contact us", []],
  ["[Contact us]()", "Contact us", []],
  ["[Contact us]( )", "Contact us", []],
  // Unsafe targets.
  ["[Click](javascript:alert(1))", "Click", []],
  ["[Click](JaVaScRiPt:alert(document.cookie))", "Click", []],
  ["[Click]( javascript:alert(1) )", "Click", []],
  ["[Click](java\tscript:alert(1))", "Click", []],
  ["[Click](data:text/html;base64,PHNjcmlwdD4=)", "Click", []],
  ["[Click](vbscript:msgbox)", "Click", []],
  ["[Click](file:///etc/passwd)", "Click", []],
  ["[Mail](mailto:someone@evil.example)", "Mail", []],
  [
    "[<img src=x onerror=alert(1)>](https://www.progress.com/pricing)",
    "<img src=x onerror=alert(1)>",
    ["https://www.progress.com/pricing"],
  ],
  ['[Pricing](https://www.progress.com/pricing" onmouseover="alert(1))', "Pricing", []],
  // Relative paths.
  ["[Pricing](/pricing)", "Pricing", ["https://www.progress.com/pricing"]],
  ["[Pricing](/pricing/)", "Pricing", ["https://www.progress.com/pricing"]],
  ["[Pricing](pricing)", "Pricing", ["https://www.progress.com/pricing"]],
  ["[Pricing](./pricing)", "Pricing", ["https://www.progress.com/pricing"]],
  ["[Pricing](../pricing)", "Pricing", ["https://www.progress.com/pricing"]],
  ["[Pricing](/Pricing?utm=chat#plans)", "Pricing", ["https://www.progress.com/pricing"]],
  ["[Interactive demos](/interactive-demos)", "Interactive demos", []],
  ["[Partners](partners.aspx)", "Partners", []],
  // Absolute addresses.
  ["[Pricing](https://www.progress.com/pricing)", "Pricing", ["https://www.progress.com/pricing"]],
  ["[Pricing](https://progress.com/pricing)", "Pricing", ["https://progress.com/pricing"]],
  ["[Pricing](www.progress.com/pricing)", "Pricing", ["https://www.progress.com/pricing"]],
  ["[Pricing](//www.progress.com/pricing)", "Pricing", ["https://www.progress.com/pricing"]],
  ["[Pricing](<https://www.progress.com/pricing>)", "Pricing", ["https://www.progress.com/pricing"]],
  ['[Pricing](https://www.progress.com/pricing "Our prices")', "Pricing", ["https://www.progress.com/pricing"]],
  ["[Interactive demos](https://www.progress.com/interactive-demos)", "Interactive demos", []],
  ["[Phish](https://www.progress.com.evil.example/pricing)", "Phish", []],
  ["[Phish](https://evil.example/pricing)", "Phish", []],
  ["[Demo](https://calendly.com/progress/demo)", "Demo", ["https://calendly.com/progress/demo"]],
  ["[Email sales](mailto:sales@progress.com)", "Email sales", ["mailto:sales@progress.com"]],
  // Nested brackets.
  ["[[Pricing]](/pricing)", "Pricing", ["https://www.progress.com/pricing"]],
  ["[See [our] plans](/pricing)", "See our plans", ["https://www.progress.com/pricing"]],
  ["[[Pricing](/pricing)]", "Pricing", ["https://www.progress.com/pricing"]],
  ["[Pricing [page](/pricing)](/pricing)", "Pricing page", ["https://www.progress.com/pricing"]],
  ["[Pricing](/pricing)]", "Pricing", ["https://www.progress.com/pricing"]],
  ["[Wiki](https://www.progress.com/pricing_(2026))", "Wiki", []],
  // Unclosed brackets.
  ["[Request a Demo](Request a Demo", "Request a Demo", ["https://www.progress.com/request-a-demo"]],
  ["[Pricing](/pricing and more", "Pricing and more", ["https://www.progress.com/pricing"]],
  ["[Pricing](https://www.progress.com/pricing", "Pricing", ["https://www.progress.com/pricing"]],
  ["See [Pricing for the plans.", "See Pricing for the plans.", []],
  ["See Pricing] for the plans.", "See Pricing for the plans.", []],
  ["Request a Demo](https://www.progress.com/request-a-demo) now", "Request a Demo now", []],
  ["[Pricing", "Pricing", []],
  ["Plans ](", "Plans (", []],
  // Brackets without a target, references, footnotes, images.
  ["[Pricing]", "Pricing", []],
  ["[Pricing] (see the plans page)", "Pricing (see the plans page)", []],
  ["[Pricing] (/pricing)", "Pricing", ["https://www.progress.com/pricing"]],
  ["[Pricing][1]\n\n[1]: https://www.progress.com/pricing", "Pricing", []],
  ["Plans start at $4,500 [1].", "Plans start at $4,500.", []],
  ["Plans start at $4,500 [^2] a year.", "Plans start at $4,500 a year.", []],
  ["![Logo](https://www.progress.com/logo.png)", "Logo", []],
  ["Escaped \\[Pricing\\]", "Escaped Pricing", []],
  ["Use `arr[0]` here", "Use arr0 here", []],
  // In emphasis and lists.
  ["**[Pricing](/pricing)**", "Pricing", ["https://www.progress.com/pricing"]],
  ["- [Request a Demo](Request a Demo)\n- [Pricing](#)", "Request a DemoPricing", ["https://www.progress.com/request-a-demo"]],
];

describe("renderModelText: malformed links", () => {
  it(`covers at least 40 variants (${VARIANTS.length})`, () => assert.ok(VARIANTS.length >= 40));

  for (const [input, text, links] of VARIANTS) {
    it(JSON.stringify(input), () => {
      const { html } = renderModelText(input, ctx);
      assertSafe(html);
      assert.equal(
        visible(html)
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/&amp;/g, "&"),
        text,
      );
      assert.deepEqual(hrefs(html), links);
    });
  }
});

describe("renderModelText", () => {
  it("renders well-formed links to synced pages as links, and says nothing was repaired", () => {
    const r = renderModelText("See [our pricing](https://www.progress.com/pricing) or **call**.", ctx);
    assert.equal(
      r.html,
      '<p>See <a href="https://www.progress.com/pricing" target="_blank" rel="noopener noreferrer">our pricing</a> or <strong>call</strong>.</p>',
    );
    assert.equal(r.repaired, false);
  });

  it("says when it repaired something, for validation's note", () => {
    assert.equal(renderModelText("[Request a Demo](Request a Demo)", ctx).repaired, true);
    assert.equal(renderModelText("[Pricing](#)", ctx).repaired, true);
    assert.equal(renderModelText("Plans [1].", ctx).repaired, true);
    assert.equal(renderModelText("[Interactive demos](/interactive-demos)", ctx).repaired, true);
    assert.equal(renderModelText("Plain text, **bold**, a list:\n\n- one\n- two", ctx).repaired, false);
  });

  it("escapes everything the model writes", () => {
    const r = renderModelText('<script>alert("x")</script> & <b>bold</b>', ctx);
    assert.equal(r.html, "<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &lt;b&gt;bold&lt;/b&gt;</p>");
  });

  it("renders lists, headings and line breaks", () => {
    assert.equal(
      renderModelText("## Plans\n3. Standard\n4. Enterprise", ctx).html,
      '<p><strong>Plans</strong></p><ol start="3"><li>Standard</li><li>Enterprise</li></ol>',
    );
    assert.equal(renderModelText("Mon–Fri\n9–5", ctx).html, "<p>Mon–Fri<br>9–5</p>");
  });

  it("links any page on the deployment's own site once the synced set is capped", () => {
    const capped = { ...ctx, capped: true };
    assert.deepEqual(hrefs(renderModelText("[Demos](https://www.progress.com/interactive-demos)", capped).html), [
      "https://www.progress.com/interactive-demos",
    ]);
    assert.deepEqual(hrefs(renderModelText("[Phish](https://evil.example/x)", capped).html), []);
    assert.deepEqual(hrefs(renderModelText("[Click](javascript:alert(1))", capped).html), []);
  });

  it("shows plain text with no context at all", () => {
    const r = renderModelText("[Pricing](https://www.progress.com/pricing) and [Demo](Request a Demo)");
    assert.equal(r.html, "<p>Pricing and Demo</p>");
  });
});

describe("parseModelText while streaming", () => {
  it("hides a target still arriving and an unclosed bracket", () => {
    assert.equal(plainText(parseModelText("See [Pricing](https://www.progress.com/pri", true)), "See Pricing");
    assert.equal(plainText(parseModelText("See [Pric", true)), "See Pric");
  });
});

describe("linkFor", () => {
  it("never returns an unsafe href, whatever the target", () => {
    for (const t of ["javascript:x", " JAVASCRIPT:x", "data:x", "blob:x", "about:blank", "chrome://settings", "\\\\evil\\share"])
      assert.equal(linkFor(t, "x", { ...ctx, capped: true }), undefined, t);
  });
});

describe("compactPagePaths", () => {
  it("keeps distinct paths in order, capped", () => {
    assert.deepEqual(compactPagePaths(["https://a.com/Pricing/", "https://www.a.com/pricing?x=1", "https://a.com/", "/contact"]), {
      paths: ["/pricing", "/", "/contact"],
      capped: false,
    });
    assert.deepEqual(compactPagePaths(["https://a.com/a", "https://a.com/b", "https://a.com/c"], 2), { paths: ["/a", "/b"], capped: true });
  });
});
