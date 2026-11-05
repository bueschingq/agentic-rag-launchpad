// Fix cycle 7c: the price table is proposed by a model and proved by code. fixtures/price-model-replies.json
// holds what the model really replied on 2 Nov 2026 (through lib/price-table-model.ts askModelForPrices)
// for seven pages' stored text, with that text; here nothing calls a model. Each proof also has a
// synthetic case, so it isn't about these sites.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { PageFacts, PriceRow, PriceTable } from "@launchpad/db";
import { orderHandoffSuggestions } from "../src/app/customers/[id]/deployments/[deploymentId]/widget/handoff-suggestions.ts";
import { priceTableIssue } from "../src/lib/overview.ts";
import { buildPriceTable, combineRead, priceDoubts } from "../src/lib/price-table.ts";
import {
  MAX_MODEL_PAGES,
  modelPriceReader,
  pageTextForModel,
  pageTextHash,
  parseProposal,
  pricePrompt,
  proveRows,
} from "../src/lib/price-table-model.ts";
import { editPriceRow, priceTableLine } from "../src/lib/review.ts";

const NOW = new Date("2026-11-02T12:00:00Z");
type Reply = { proposed: Parameters<typeof proveRows>[0]; text: string };
const replies = JSON.parse(readFileSync(new URL("fixtures/price-model-replies.json", import.meta.url), "utf8")) as Record<string, Reply>;
const proved = (site: string, url = `https://${site}.example/pricing`) =>
  proveRows(replies[site]!.proposed, { url, text: replies[site]!.text });
const find = (rows: readonly PriceRow[], plan: string, value: number) => rows.find((r) => r.plan === plan && r.value === value);

describe("the reply is read", () => {
  it("takes rows in shape, and leaves out what isn't one", () => {
    const rows = parseProposal(
      'Here: {"rows":[{"plan":"Basic","amount":"$9","unit":null,"period":"month","qualifiers":["billed monthly"],"addOn":false},{"plan":"","amount":"$1"}]}',
    );
    assert.deepEqual(rows, [{ plan: "Basic", amount: "$9", period: "month", qualifiers: ["billed monthly"] }]);
  });
  it("keeps the rows before a reply cut off by the length limit", () => {
    const rows = parseProposal('{"rows":[{"plan":"Basic","amount":"$9"},{"plan":"Pro","amount":"$19"},{"plan":"Te');
    assert.deepEqual(
      rows?.map((r) => r.plan),
      ["Basic", "Pro"],
    );
  });
  it("says it can't when it isn't such a reply", () => {
    assert.equal(parseProposal("I can't read this page."), undefined);
    assert.equal(parseProposal('{"verdict":"answers"}'), undefined);
  });
  it("a page with no rows is an answer, not a failure", () => {
    assert.deepEqual(parseProposal('{"rows":[]}'), []);
  });
});

describe("the proof", () => {
  const page = {
    url: "https://x.example/pricing",
    text: ["## Starter", "Starter: $ 1,250.00 per seat", "- 10 seats", "", "## Scale", "Scale: €90 /mo", "Billed yearly"].join("\n"),
  };

  it("rejects a figure the page doesn't state, and never works one out", () => {
    const { rows, rejected } = proveRows(
      [
        { plan: "Scale", amount: "€1,080", period: "year" },
        { plan: "Starter", amount: "$99" },
      ],
      page,
    );
    assert.deepEqual(rows, []);
    assert.deepEqual(
      rejected.map((r) => r.why),
      ["The page doesn't state €1,080.", "The page doesn't state $99."],
    );
  });

  it("rejects a plan the page doesn't name, and a figure in another currency", () => {
    const { rows, rejected } = proveRows(
      [
        { plan: "Growth", amount: "€90" },
        { plan: "Scale", amount: "$90" },
      ],
      page,
    );
    assert.deepEqual(rows, []);
    assert.match(rejected[0]!.why, /doesn't name "Growth"/);
    assert.match(rejected[1]!.why, /doesn't state \$90/);
  });

  it("keeps the page's own writing of the figure, and records the line", () => {
    const [row] = proveRows([{ plan: "Starter", amount: "$1250", unit: "per seat" }], page).rows;
    assert.equal(row?.amount, "$ 1,250.00");
    assert.equal(row?.value, 1250);
    assert.equal(row?.currency, "USD");
    assert.equal(row?.unit, "per seat");
    assert.equal(row?.line, "Starter: $ 1,250.00 per seat");
    assert.equal(row?.url, page.url);
  });

  it("drops a period, unit or qualifier the page doesn't state", () => {
    const [row] = proveRows(
      [{ plan: "Starter", amount: "$ 1,250.00", period: "year", unit: "per device", qualifiers: ["500 devices", "10 seats"] }],
      page,
    ).rows;
    assert.equal(row?.period, undefined);
    assert.equal(row?.unit, undefined);
    assert.deepEqual(row?.qualifiers, ["10 seats"]);
  });

  it("doubts a figure that sits nearer another plan, and says why", () => {
    const rows = proveRows(
      [
        { plan: "Starter", amount: "€90" },
        { plan: "Scale", amount: "€90" },
      ],
      page,
    ).rows;
    assert.match(find(rows, "Starter", 90)?.doubt ?? "", /€90 sits nearer "Scale" than "Starter"/);
    assert.equal(find(rows, "Scale", 90)?.doubt, undefined);
  });

  it("on a sentence naming two plans, each figure goes with the name before it", () => {
    const text = "Basic is $120 per user per year, and Premium is $200.";
    const rows = proveRows(
      [
        { plan: "Basic", amount: "$120" },
        { plan: "Premium", amount: "$200" },
        { plan: "Basic", amount: "$200" },
      ],
      { url: page.url, text },
    ).rows;
    assert.equal(find(rows, "Basic", 120)?.doubt, undefined);
    assert.equal(find(rows, "Premium", 200)?.doubt, undefined);
    assert.match(find(rows, "Basic", 200)?.doubt ?? "", /nearer "Premium"/);
  });

  it("a free plan's $0 is a price", () => {
    const [row] = proveRows([{ plan: "Free", amount: "$0.00", period: "month" }], {
      url: page.url,
      text: "### Free\n\nFree: $0.00 /mo",
    }).rows;
    assert.equal(row?.value, 0);
    assert.equal(row?.period, "month");
  });

  it("a name the model noted in brackets is the page's name", () => {
    const [row] = proveRows([{ plan: "Pro (annual)", amount: "$5" }], { url: page.url, text: "Pro: $5" }).rows;
    assert.equal(row?.plan, "Pro");
  });

  it("volume tiers stay apart, by their qualifier and their figure", () => {
    const text = [
      "## Plans",
      "### Basic",
      "Basic: $15.00 /mo for 10,000 emails",
      "Basic: $55.00 /mo for 50,000 emails",
      "Extra emails @ $ 1.80 / 1,000",
    ].join("\n");
    const rows = priceDoubts(
      proveRows(
        [
          { plan: "Basic", amount: "$15.00", period: "month", qualifiers: ["10,000 emails"] },
          { plan: "Basic", amount: "$55.00", period: "month", qualifiers: ["50,000 emails"] },
          { plan: "Basic", amount: "$ 1.80", unit: "per 1,000", qualifiers: ["extra emails"] },
        ],
        { url: page.url, text },
      ).rows,
    );
    assert.deepEqual(find(rows, "Basic", 15)?.qualifiers, ["10,000 emails"]);
    assert.deepEqual(find(rows, "Basic", 55)?.qualifiers, ["50,000 emails"]);
    assert.equal(find(rows, "Basic", 1.8)?.unit, "per 1,000");
    assert.deepEqual(
      rows.flatMap((r) => (r.doubt ? [r.doubt] : [])),
      [],
    );
  });

  it("tells a monthly price billed yearly from a yearly price", () => {
    const text = "Team: $25 / month, billed annually\n\nTeam: $300 per year";
    const rows = proveRows(
      [
        { plan: "Team", amount: "$25", period: "month", qualifiers: ["billed annually"] },
        { plan: "Team", amount: "$300", period: "year" },
      ],
      { url: page.url, text },
    ).rows;
    assert.equal(find(rows, "Team", 25)?.period, "month");
    assert.equal(find(rows, "Team", 300)?.period, "year");
  });
});

describe("the model's real replies, proved against each page's stored text", () => {
  it("SavvyCal: right names, both billing cycles, nothing named 'Basic is'", () => {
    const { rows } = proved("savvycal");
    for (const [plan, value] of [
      ["Basic", 10],
      ["Basic", 12],
      ["Basic", 120],
      ["Premium", 17],
      ["Premium", 20],
      ["Premium", 200],
    ] as const)
      assert.ok(find(rows, plan, value), `${plan} ${value}`);
    assert.deepEqual([...new Set(rows.map((r) => r.plan))].sort(), ["Basic", "Premium"]);
    assert.equal(find(rows, "Premium", 240), undefined, "'instead of $240' isn't a price");
  });

  it("SmugMug: the toggle's monthly figures, read as the sniffer now adds them", () => {
    const { rows } = proved("smug");
    assert.equal(find(rows, "Direct", 20)?.period, "month");
    assert.ok(find(rows, "Direct", 20)?.qualifiers?.includes("billed annually"));
    assert.ok(find(rows, "Direct", 29)?.qualifiers?.includes("billed monthly"), "real billing words tell a plan's two prices apart");
    assert.ok(find(rows, "Portfolio", 23.5)?.qualifiers?.includes("billed annually"));
    assert.ok(find(rows, "Portfolio", 35.5)?.qualifiers?.includes("billed monthly"));
    assert.equal(find(rows, "Pro", 52)?.period, "month");
    assert.ok(rows.some((r) => r.addOn && r.value === 10));
    assert.ok(!rows.some((r) => /enterprise/i.test(r.plan)), "Enterprise is 'reach out'");
  });

  it("Postmark: overage rates belong to their plans, per 1,000, and the volume is said", () => {
    const { rows } = proved("postmark");
    assert.deepEqual(find(rows, "Basic", 15)?.qualifiers, ["10,000 emails"]);
    assert.match(find(rows, "Pro", 1.3)?.unit ?? "", /per 1,000 extra emails/i);
    assert.equal(find(rows, "Pro", 1.3)?.addOn, true, "an overage rate isn't the plan's price");
    assert.ok(!rows.some((r) => /extra emails/i.test(r.plan)));
    assert.equal(find(rows, "Free", 0)?.period, "month");
    for (const addOn of ["Dedicated IPs", "Custom activity retention", "DMARC monitoring"])
      assert.ok(rows.find((r) => r.plan === addOn)?.addOn, addOn);
    assert.equal(rows.length, 10);
    assert.ok(!rows.some((r) => r.value === 75), "the bootstrapped credit isn't a price");
  });

  it("Kemp: each tab's figures, under its own names", () => {
    const { rows } = proved("kemp");
    assert.ok(find(rows, "Individual", 2205));
    assert.ok(find(rows, "Enterprise Plus", 6200));
    assert.ok(find(rows, "24x7 Live Support", 4620));
    assert.ok(find(rows, "24x7x365 Customer Support", 3190));
    assert.ok(find(rows, "Cloud", 0.41));
  });

  it("the three earlier sites read as their fixes required, all proved", () => {
    const t = proved("transistor");
    assert.deepEqual(t.rejected, []);
    for (const [plan, m, y] of [
      ["Starter", 19, 190],
      ["Professional", 49, 490],
      ["Business", 99, 990],
      ["Enterprise 1", 199, 1990],
    ] as const) {
      assert.equal(find(t.rows, plan, m)?.period, "month");
      assert.equal(find(t.rows, plan, y)?.period, "year");
    }
    assert.ok(t.rows.filter((r) => r.addOn).length === 4);
    const a = proved("alfred");
    assert.ok(find(a.rows, "Single License", 34) && find(a.rows, "Mega Supporter", 59));
    const b = proved("buzzsprout");
    for (const [plan, annual, monthly] of [
      ["Audio", 15, 18],
      ["Audio + Video", 25, 30],
      ["Multi-Podcast", 30, 36],
    ] as const) {
      assert.deepEqual(find(b.rows, plan, annual)?.qualifiers?.includes("billed annually"), true, `${plan} annually`);
      assert.deepEqual(find(b.rows, plan, monthly)?.qualifiers, ["billed monthly"]);
    }
  });
});

describe("the reader: what a re-read costs, and when the model fails", () => {
  const facts: PageFacts = { prices: [{ figure: "$9", line: "Basic: $9 /mo" }] };
  const page = { url: "https://x.example/pricing", title: "Pricing", text: "Basic: $9 /mo", facts };
  const okay = async () => ({ rows: [{ plan: "Basic", amount: "$9", period: "month" as const }], ms: 1 });

  it("asks once per page's text: unchanged pages cost nothing", async () => {
    let calls = 0;
    const read = modelPriceReader(async (p) => {
      calls += 1;
      return okay();
    });
    const first = await read([page], undefined);
    assert.equal(first.calls, 1);
    assert.equal(first.rows[0]?.plan, "Basic");
    const second = await read([page], first.cache);
    assert.equal(second.calls, 0);
    assert.equal(calls, 1);
    assert.deepEqual(second.rows, first.rows);
    const changed = await read([{ ...page, text: "Basic: $9 /mo\n\nNew line" }], first.cache);
    assert.equal(changed.calls, 1);
  });

  it("makes no call for a page stating no figure, nor past the limit", async () => {
    let calls = 0;
    const read = modelPriceReader(async () => {
      calls += 1;
      return okay();
    });
    await read([{ url: "https://x.example/quote", text: "Ask us for a quote.", facts: {} }], undefined);
    assert.equal(calls, 0);
    const many = Array.from({ length: MAX_MODEL_PAGES + 3 }, (_, i) => ({
      ...page,
      url: `https://x.example/p${i}`,
      text: `Basic: $9 /mo ${i}`,
    }));
    await read(many, undefined);
    assert.equal(calls, MAX_MODEL_PAGES);
  });

  it("the patterns stand in when the call fails, and the table says so", async () => {
    const read = await modelPriceReader(async () => ({ error: "The model couldn't be asked: 503", ms: 1 }))([page], undefined);
    assert.deepEqual(read.failed, [page.url]);
    const table = combineRead(buildPriceTable([page], NOW, "en"), [page], read);
    assert.equal(table.builtBy, "patterns");
    assert.equal(table.modelError, "The model couldn't be asked: 503");
    assert.equal(table.rows[0]?.plan, "Basic");
    assert.equal(combineRead(buildPriceTable([page], NOW, "en"), [page], undefined).builtBy, "patterns");
  });

  it("the patterns read only the pages the call failed on", async () => {
    const other = {
      url: "https://x.example/other-pricing",
      text: "Team: $29 /mo",
      facts: { prices: [{ figure: "$29", line: "Team: $29 /mo" }] },
    };
    const read = await modelPriceReader(async (p) => (p.url === page.url ? okay() : { error: "no", ms: 1 }))([page, other], undefined);
    const table = combineRead(buildPriceTable([page, other], NOW, "en"), [page, other], read);
    assert.equal(table.builtBy, "model+patterns");
    assert.deepEqual(table.rows.map((r) => r.plan).sort(), ["Basic", "Team"]);
  });

  it("the patterns stand in, too, when the proof rejects everything", async () => {
    const read = await modelPriceReader(async () => ({ rows: [{ plan: "Invented", amount: "$1,000" }], ms: 1 }))([page], undefined);
    const table = combineRead(buildPriceTable([page], NOW, "en"), [page], read);
    assert.equal(table.builtBy, "patterns");
    assert.equal(table.rejected?.[0]?.plan, "Invented");
    assert.equal(table.rows[0]?.plan, "Basic");
  });

  it("a model's table is said to be one, with the rejected rows listed", async () => {
    const read = await modelPriceReader(async () => ({
      rows: [
        { plan: "Basic", amount: "$9", period: "month" as const },
        { plan: "Basic", amount: "$99", period: "year" as const },
      ],
      ms: 1,
    }))([page], undefined);
    const table = combineRead(buildPriceTable([page], NOW, "en"), [page], read);
    assert.equal(table.builtBy, "model");
    assert.equal(table.rows.length, 1);
    assert.equal(table.rejected?.[0]?.amount, "$99");
    assert.equal(pageTextHash("a"), pageTextHash("a"));
  });

  it("no rows from the model on a page with figures: the gap says so, the patterns' junk isn't taken", async () => {
    const junk = {
      url: "https://x.example/pricing",
      text: "We think this offer of $12 is the one.",
      facts: { prices: [{ figure: "$12", line: "We think this offer of $12 is the one." }] },
    };
    const read = await modelPriceReader(async () => ({ rows: [], ms: 1 }))([junk], undefined);
    const table = combineRead(buildPriceTable([junk], NOW, "en"), [junk], read);
    assert.deepEqual(table.rows, []);
    assert.equal(table.gap?.kind, "unread");
    assert.equal(table.builtBy, "model");
  });

  it("a figure the model left out under a plan it names is kept, doubted", async () => {
    const two = {
      url: "https://x.example/pricing",
      text: "Basic: $9 /mo\n\nBasic: $90 /year",
      facts: {
        prices: [
          { figure: "$9", line: "Basic: $9 /mo" },
          { figure: "$90", line: "Basic: $90 /year" },
        ],
      },
    };
    const read = await modelPriceReader(okay)([two], undefined);
    const table = combineRead(buildPriceTable([two], NOW, "en"), [two], read);
    assert.match(find(table.rows, "Basic", 90)?.doubt ?? "", /didn't list this figure/);
    assert.equal(find(table.rows, "Basic", 9)?.doubt, undefined);
  });

  it("a long page keeps its figures for the model", () => {
    const text = [...Array.from({ length: 3000 }, (_, i) => `Filler line ${i} about features`), "## Plans", "Basic: $9 /mo"].join("\n");
    const cut = pageTextForModel(text, 2000);
    assert.ok(cut.length <= 2000);
    assert.match(cut, /Basic: \$9/);
    assert.match(pricePrompt({ url: "https://x.example/p", text }), /Basic: \$9/);
  });
});

describe("doubt is shown", () => {
  const row = (plan: string, value: number, more: Partial<PriceRow> = {}): PriceRow => ({
    plan,
    amount: `$${value}`,
    value,
    currency: "USD",
    url: "https://x.example/p",
    line: `${plan} $${value}`,
    ...more,
  });

  it("doubts a name that reads as a badge or a heading, and says why", () => {
    const [r] = priceDoubts([row("Most popular", 9, { period: "month" })]);
    assert.ok(r?.doubt);
  });
  it("doubts two prices for one plan on the same terms, not on different ones", () => {
    const same = priceDoubts([row("Basic", 15, { period: "month" }), row("Basic", 55, { period: "month" })]);
    assert.match(same[0]?.doubt ?? "", /same terms as \$55 for Basic/);
    const apart = priceDoubts([
      row("Basic", 15, { period: "month", qualifiers: ["10,000 emails"] }),
      row("Basic", 55, { period: "month", qualifiers: ["50,000 emails"] }),
    ]);
    assert.deepEqual(
      apart.map((r) => r.doubt),
      [undefined, undefined],
    );
  });
  it("doubts a year cheaper than a month", () => {
    const [, year] = priceDoubts([row("Basic", 50, { period: "month" }), row("Basic", 10, { period: "year" })]);
    assert.match(year?.doubt ?? "", /less for a year/);
  });
  it("doubts a figure far from its peers", () => {
    const rows = priceDoubts([
      row("A", 20, { period: "month" }),
      row("B", 30, { period: "month" }),
      row("C", 40, { period: "month" }),
      row("D", 9000, { period: "month" }),
    ]);
    assert.match(rows[3]?.doubt ?? "", /far from the other plans/);
    assert.equal(rows[0]?.doubt, undefined);
  });
  it("a doubted table is in Needs attention, confirmed or not, and a doubt doesn't move the hash", () => {
    const rows = priceDoubts([row("Basic", 15, { period: "month" }), row("Basic", 55, { period: "month" })]);
    const table = { rows, hash: "h" };
    assert.equal(priceTableIssue(table, { hash: "h" }, true), "doubted");
    assert.equal(priceTableIssue(table, null, false), "doubted");
    assert.equal(priceTableIssue(table, { hash: "older" }, true), "changed");
    assert.equal(priceTableIssue({ rows: [row("Basic", 15)], hash: "h" }, { hash: "h" }, true), undefined);
  });
});

describe("the model isn't on the chat's path", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
    });
  const root = new URL("../../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  it("only the worker's sync imports it", () => {
    const importers = [
      ...files(join(root, "apps/console/src")),
      ...files(join(root, "apps/worker/src")),
      ...files(join(root, "packages/widget/src")),
      ...files(join(root, "packages/theme/src")),
    ].filter((f) => !f.endsWith("price-table-model.ts") && /from "[^"]*price-table-model/.test(readFileSync(f, "utf8")));
    assert.deepEqual(
      importers.map((f) => f.replace(/\\/g, "/").replace(/^.*\/apps\//, "apps/")),
      ["apps/worker/src/jobs/content.ts"],
    );
  });
});

describe("a doubt on the card, and a person's answer to it", () => {
  const doubted = (): PriceTable => ({
    rows: [
      {
        plan: "Basic",
        amount: "$15",
        value: 15,
        currency: "USD",
        period: "month",
        url: "https://x.example/p",
        line: "Basic $15",
        doubt: "It's doubted.",
      },
      {
        plan: "Pro",
        amount: "$30",
        value: 30,
        currency: "USD",
        period: "month",
        url: "https://x.example/p",
        line: "Pro $30",
        doubt: "This too.",
      },
    ],
    pages: ["https://x.example/p"],
    readAt: NOW.toISOString(),
    hash: "h",
    builtBy: "model",
    modelRead: { version: 1, pages: { k: { rows: [] } } },
  });

  it("correcting a row drops its doubt, leaves the others', and keeps the table's cache", () => {
    const edited = editPriceRow(doubted(), 0, { amount: "$15" });
    assert.ok(!("error" in edited));
    if ("error" in edited) return;
    assert.equal(edited.table.rows[0]?.doubt, undefined);
    assert.equal(edited.table.rows[1]?.doubt, "This too.");
    assert.equal(edited.table.builtBy, "model");
    assert.ok(edited.table.modelRead?.pages.k);
    assert.equal(priceTableIssue(edited.table, { hash: edited.table.hash }, true), "doubted");
    const both = editPriceRow(edited.table, 1, { amount: "$30" });
    assert.ok(!("error" in both) && priceTableIssue(both.table, { hash: both.table.hash }, true) === undefined);
  });

  it("the card says why, as text in the row, with no new control to reach", () => {
    const card = readFileSync(
      new URL("../src/app/customers/[id]/deployments/[deploymentId]/price-table/price-table-card.tsx", import.meta.url),
      "utf8",
    );
    assert.match(card, /row\.doubt && \(\s*<span className="help"/);
    assert.match(card, /\{row\.doubt\} Correct it/);
  });

  it("Review's line and the card don't claim anything before a page is read", () => {
    assert.equal(priceTableLine("/d", null, null, false).detail, "No price table yet: no page has been read.");
    assert.match(priceTableLine("/d", null, null).detail ?? "", /no pricing page was found/);
    const section = readFileSync(
      new URL("../src/app/customers/[id]/deployments/[deploymentId]/price-table/price-table-section.tsx", import.meta.url),
      "utf8",
    );
    assert.match(section, /read = table \? true : await priceTableRead\(deploymentId\)/);
    assert.match(section, /noPriceTableNote\(table, read\)/);
  });
});

describe("the handoff's first suggestion", () => {
  const internal = {
    contact: { kind: "email" as const, url: "mailto:dana@agency.example" },
    why: "the customer's primary contact",
    from: "primary" as const,
  };
  it("is the support key page when there's no contact key page, with the internal contact last", () => {
    const ordered = orderHandoffSuggestions([internal as never], null, "https://x.example/customer-service");
    assert.equal(ordered[0]?.contact.url, "https://x.example/customer-service");
    assert.equal(ordered[0]?.why, "The support key page");
    assert.equal(ordered.at(-1)?.from, "primary");
  });
  it("is the contact key page when there is one", () => {
    const ordered = orderHandoffSuggestions([internal as never], "https://x.example/contact", "https://x.example/customer-service");
    assert.equal(ordered[0]?.contact.url, "https://x.example/contact");
    assert.ok(!ordered.some((s) => s.contact.url.includes("customer-service")));
  });
});
