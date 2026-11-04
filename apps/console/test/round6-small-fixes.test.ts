// Round 6, item 7: the small fixes for things the console said wrongly. Review's rules line, the
// costs page's test traffic, the handoff suggestions' order and words, the dashboard's first-of-month
// tiles, and Needs attention for a price table to confirm.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  orderHandoffSuggestions,
  PRIMARY_EMAIL_NOTE,
} from "../src/app/customers/[id]/deployments/[deploymentId]/widget/handoff-suggestions.ts";
import { customerCostCents, testTrafficByTenant } from "../src/lib/costs.ts";
import { rulesChangeLine } from "../src/lib/history.ts";
import type { DeploymentView, TenantView } from "../src/lib/metrics.ts";
import { attentionItems, headlineFigures, PRICE_TABLE_ISSUES, priceTableIssue } from "../src/lib/overview.ts";
import type { ContactSuggestion } from "../src/lib/widget-form.ts";

describe("Review's changes since sign-off: answering rules", () => {
  it("says which versions, and how they were applied", () => {
    assert.equal(
      rulesChangeLine({ from: 4, to: 5, recheck: { total: 14, unchanged: 12, better: 2 } }),
      "answering rules v4 → v5, applied after a re-check",
    );
    assert.equal(rulesChangeLine({ from: 4, to: 5, name: "Dana" }), "answering rules v4 → v5, switched by Dana (not verified)");
    assert.equal(rulesChangeLine({ from: 4, to: 5 }, "Sam Lee"), "answering rules v4 → v5, switched by Sam Lee");
    assert.equal(rulesChangeLine({ from: 4, to: 5 }), "answering rules v4 → v5, applied");
    assert.equal(rulesChangeLine({}), undefined);
  });
});

describe("Costs: test traffic", () => {
  const tenantOf = new Map([
    ["chef-prod", "chef"],
    ["chef-staging", "chef"],
    ["kemp", "kemp"],
  ]);
  it("splits each day's cost by its share of test questions, and leaves it out of the customer price", () => {
    const usage = [
      { deploymentId: "chef-prod", day: "2026-10-03", costCents: 1000 },
      { deploymentId: "chef-staging", day: "2026-10-03", costCents: 300 },
      { deploymentId: "kemp", day: "2026-10-04", costCents: 500 },
      // A day the question log doesn't cover stays the customer's.
      { deploymentId: "kemp", day: "2026-10-05", costCents: 700 },
    ];
    const asked = [
      { deploymentId: "chef-prod", day: "2026-10-03", total: 10, test: 2 },
      { deploymentId: "chef-staging", day: "2026-10-03", total: 3, test: 3 },
      { deploymentId: "kemp", day: "2026-10-04", total: 5, test: 0 },
    ];
    const test = testTrafficByTenant(usage, asked, tenantOf);
    assert.deepEqual(test.get("chef"), { questions: 5, costCents: 500 });
    assert.equal(test.get("kemp"), undefined);
    assert.equal(customerCostCents(1300, test.get("chef")), 800);
    assert.equal(customerCostCents(1200, test.get("kemp")), 1200);
  });
});

describe("Handoff suggestions", () => {
  const primary: ContactSuggestion[] = [
    { contact: { kind: "link", url: "mailto:dana@client.com" }, why: "Dana's email (the customer's primary contact)", from: "primary" },
    { contact: { kind: "link", url: "https://client.com/contact" }, why: "The site's contact page", from: "pages" },
  ];
  it("puts the contact key page first, and the customer's internal contact last, labelled as such", () => {
    const ordered = orderHandoffSuggestions(primary, "https://client.com/get-in-touch");
    assert.deepEqual(
      ordered.map((s) => s.contact.url),
      ["https://client.com/get-in-touch", "https://client.com/contact", "mailto:dana@client.com"],
    );
    assert.equal(ordered[0]?.why, "The contact key page");
    assert.equal(ordered.at(-1)?.why, `Dana's email (the customer's internal contact): ${PRIMARY_EMAIL_NOTE}`);
  });
  it("never offers the internal contact first, even without a contact page", () => {
    const ordered = orderHandoffSuggestions([primary[0] as ContactSuggestion]);
    assert.match(ordered[0]?.why ?? "", /only if the client wants visitors to email this person/);
    assert.deepEqual(
      orderHandoffSuggestions(primary, "https://client.com/contact/").map((s) => s.contact.url),
      ["https://client.com/contact/", "mailto:dana@client.com"],
    );
  });
});

describe("Dashboard tiles on the 1st", () => {
  const daily = Array.from({ length: 30 }, (_, i) => ({
    day: new Date(Date.UTC(2026, 9, 2 + i)).toISOString().slice(0, 10),
    questions: 10,
    costCents: 100,
  }));
  it("labels the last 30 days on the 1st, so no 0 sits beside an up arrow", () => {
    const f = headlineFigures({ monthCents: 0, daily }, "2026-11-01");
    assert.deepEqual(f.cost, { label: "Cost, last 30 days", cents: 3000 });
    assert.deepEqual(f.questions, { label: "Questions, last 30 days", count: 300, showChange: true });
    assert.equal(f.projection.label, "Projected for November, at last 7 days' pace");
  });
  it("labels the month by name once it has a rolled-up day", () => {
    const f = headlineFigures(
      { monthCents: 200, daily: [...daily.slice(2), { day: "2026-11-01", questions: 0, costCents: 200 }] },
      "2026-11-02",
    );
    assert.equal(f.cost.label, "Cost in November");
    assert.deepEqual(f.questions, { label: "Questions in November", count: 0, showChange: false });
  });
});

describe("Needs attention: a price table to confirm", () => {
  const table = { rows: [{}], hash: "b" };
  it("flags a table whose rows changed since they were confirmed, and a live chat's unconfirmed table", () => {
    assert.equal(priceTableIssue(table, { hash: "a" }, false), "changed");
    assert.equal(priceTableIssue(table, undefined, true), "unconfirmed");
    assert.equal(priceTableIssue(table, undefined, false), undefined);
    assert.equal(priceTableIssue(table, { hash: "b" }, true), undefined);
    assert.equal(priceTableIssue({ rows: [], hash: "x" }, undefined, true), undefined);
  });
  it("lists the deployment with the issue", () => {
    const d = {
      id: "d1",
      tenantId: "t1",
      name: "Kemp",
      siteUrl: "https://kemp.ax",
      alerts: [],
      priceTable: "changed",
    } as unknown as DeploymentView;
    const t = { id: "t1", name: "Kemp", alerts: [], deployments: [d] } as unknown as TenantView;
    const [item] = attentionItems({ tenants: [t] });
    assert.deepEqual(item?.issues, [{ tone: "warning", text: PRICE_TABLE_ISSUES.changed }]);
    assert.equal(item?.href, "/customers/t1/deployments/d1/review");
  });
});
