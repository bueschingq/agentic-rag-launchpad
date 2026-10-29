import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatChange, formatCount, formatMoney, formatMoneyTick } from "../src/lib/format.ts";
import {
  buildDashboard,
  budgetState,
  type DeploymentRow,
  isMonth,
  lastDays,
  monthTotals,
  niceTicks,
  shiftDay,
  summarizeQuality,
  summarizeUsage,
  type TenantView,
  toCsv,
  type UsageDay,
} from "../src/lib/metrics.ts";

const TODAY = "2026-10-28";
const usage = (day: string, questions: number, costCents: number | null = questions * 5, deploymentId = "d1"): UsageDay => ({
  deploymentId,
  day,
  questions,
  queryTokens: questions * 0.2,
  costCents,
});

describe("lastDays", () => {
  it("ends yesterday, because rollups cover complete days", () => {
    assert.deepEqual(lastDays(TODAY, 3), ["2026-10-25", "2026-10-26", "2026-10-27"]);
    assert.deepEqual(lastDays("2026-03-01", 2), ["2026-02-27", "2026-02-28"]);
  });
});

describe("summarizeUsage", () => {
  // 10 questions (50¢) a day from Sep 1 to yesterday.
  const rows: UsageDay[] = [];
  for (let day = "2026-09-01"; day < TODAY; day = shiftDay(day, 1)) rows.push(usage(day, 10));

  it("counts the last 7 and 30 complete days and the 30 before", () => {
    const s = summarizeUsage(rows, TODAY);
    assert.equal(s.questions7, 70);
    assert.equal(s.questions30, 300);
    assert.equal(s.questionsPrev30, 270, "Aug 29–31 have no rows");
    assert.equal(s.daily.length, 30);
    assert.equal(s.daily.at(-1)?.day, "2026-10-27");
  });

  it("projects the month from its total so far and the last week's pace", () => {
    const s = summarizeUsage(rows, TODAY);
    assert.equal(s.monthCents, 27 * 50);
    // Oct 28–31 still to come, at 50¢ a day.
    assert.equal(s.projectedCents, 31 * 50);
  });

  it("fills empty days and sums deployments", () => {
    const s = summarizeUsage([usage("2026-10-27", 4), usage("2026-10-27", 6, 30, "d2")], TODAY);
    assert.deepEqual(s.daily.at(-1), { day: "2026-10-27", questions: 10, costCents: 50 });
    assert.deepEqual(s.daily.at(-2), { day: "2026-10-26", questions: 0, costCents: 0 });
  });

  it("flags days rolled up without a contract rate", () => {
    const s = summarizeUsage([usage("2026-10-02", 5, null), usage("2026-10-03", 0, null), usage("2026-10-04", 5)], TODAY);
    assert.equal(s.unpricedDays, 1);
    assert.equal(s.monthCents, 25);
  });

  it("works on the first of the month", () => {
    const s = summarizeUsage(
      rows.filter((r) => r.day < "2026-10-01"),
      "2026-10-01",
    );
    assert.equal(s.monthCents, 0);
    assert.equal(s.projectedCents, 31 * 50);
  });
});

describe("summarizeQuality", () => {
  it("weights by questions and reports the week-on-week change", () => {
    const q = (day: string, answerRelevance: number, deploymentId = "d1") => ({
      deploymentId,
      day,
      answerRelevance,
      contextRelevance: null,
      groundedness: 4,
    });
    const rows = [q("2026-10-20", 4), q("2026-10-26", 3), q("2026-10-26", 5, "d2"), q("2026-10-15", 4.5)];
    const traffic = [usage("2026-10-26", 30), usage("2026-10-26", 10, 0, "d2")];
    const s = summarizeQuality(rows, traffic, TODAY);
    assert.equal(s.answerRelevance?.toFixed(3), ((4 + 3 * 30 + 5 * 10 + 4.5) / 42).toFixed(3));
    assert.equal(s.contextRelevance, undefined);
    assert.equal(s.groundedness, 4);
    // Last 7 days: (3×30 + 5×10) / 40 = 3.5. The 7 before: (4 + 4.5) / 2 = 4.25.
    assert.equal(s.trend, -0.75);
  });
});

describe("budgetState", () => {
  it("escalates from projected to near to over", () => {
    assert.equal(budgetState({ monthCents: 100, projectedCents: 900 }, null), "none");
    assert.equal(budgetState({ monthCents: 100, projectedCents: 900 }, 1000), "ok");
    assert.equal(budgetState({ monthCents: 100, projectedCents: 1000 }, 1000), "projected");
    assert.equal(budgetState({ monthCents: 800, projectedCents: 1000 }, 1000), "near");
    assert.equal(budgetState({ monthCents: 1000, projectedCents: 1000 }, 1000), "over");
  });
});

describe("buildDashboard", () => {
  const now = new Date(`${TODAY}T09:00:00Z`);
  const deployment = (id: string, tenantId: string, status = "live"): DeploymentRow => ({
    id,
    tenantId,
    name: id,
    siteUrl: `https://${id}.example`,
    status,
    kbSlug: id,
  });

  it("rolls deployments up into their tenant and collects alerts", () => {
    const dash = buildDashboard({
      now,
      tenants: [
        { id: "t1", name: "Acme", status: "active", monthlyBudgetCents: 1000 },
        { id: "t2", name: "Globex", status: "active", monthlyBudgetCents: null },
      ],
      deployments: [deployment("d1", "t1"), deployment("d2", "t1"), deployment("d3", "t2", "failed")],
      usage: [usage("2026-10-27", 100, 600), usage("2026-10-27", 100, 500, "d2")],
      quality: [],
      syncs: [
        { deploymentId: "d1", lastJobStatus: "ok", lastSyncedAt: new Date("2026-10-20T00:00:00Z") },
        { deploymentId: "d1", lastJobStatus: "ok", lastSyncedAt: new Date("2026-10-27T00:00:00Z") },
        { deploymentId: "d2", lastJobStatus: "failed", lastSyncedAt: new Date("2026-10-27T00:00:00Z") },
      ],
    });
    const [acme, globex] = dash.tenants as [TenantView, TenantView];
    assert.equal(acme.usage.monthCents, 1100);
    assert.equal(acme.budget, "over");
    assert.deepEqual(
      acme.alerts.map((a) => a.text),
      ["Over budget", "Last sync failed"],
    );
    assert.deepEqual(acme.deployments[0]?.alerts, [], "uses the newest sync, a day old");
    assert.deepEqual(
      globex.alerts.map((a) => a.text),
      ["Provisioning failed"],
    );
    assert.equal(dash.usage.questions7, 200);
  });

  it("warns about a live site that stopped syncing", () => {
    const dash = buildDashboard({
      now,
      tenants: [{ id: "t1", name: "Acme", status: "active", monthlyBudgetCents: null }],
      deployments: [deployment("d1", "t1")],
      usage: [],
      quality: [],
      syncs: [{ deploymentId: "d1", lastJobStatus: "ok", lastSyncedAt: new Date("2026-10-24T08:00:00Z") }],
    });
    assert.deepEqual(dash.tenants[0]?.alerts, [{ tone: "warning", text: "No sync for 4 days" }]);
  });
});

describe("monthTotals", () => {
  it("totals one month per tenant", () => {
    const tenantOf = new Map([
      ["d1", "t1"],
      ["d2", "t1"],
    ]);
    const lines = monthTotals([usage("2026-09-30", 5), usage("2026-10-01", 10), usage("2026-10-02", 4, null, "d2")], tenantOf, "2026-10");
    const t1 = lines.get("t1");
    assert.deepEqual([t1?.questions, t1?.queryTokens.toFixed(2), t1?.costCents, t1?.unpricedDays], [14, "2.80", 50, 1]);
  });
});

describe("niceTicks", () => {
  it("steps in round numbers past the maximum", () => {
    assert.deepEqual(niceTicks(87), [0, 25, 50, 75, 100]);
    assert.deepEqual(niceTicks(4), [0, 1, 2, 3, 4]);
    assert.deepEqual(niceTicks(0.37), [0, 0.1, 0.2, 0.3, 0.4]);
    assert.deepEqual(niceTicks(0), [0, 1]);
  });
});

describe("toCsv", () => {
  it("quotes and defuses spreadsheet formulas in text", () => {
    const rows = [
      ["Customer", "Cost"],
      ['Acme, "The" Co', 12.5],
      ["=HYPERLINK(1)", -3],
    ];
    assert.equal(toCsv(rows), 'Customer,Cost\r\n"Acme, ""The"" Co",12.5\r\n\'=HYPERLINK(1),-3\r\n');
  });
});

describe("format", () => {
  it("formats money, counts and changes", () => {
    assert.equal(formatMoney(123456, "USD"), "$1,235");
    assert.equal(formatMoney(4250, "EUR"), "€42.50");
    assert.equal(formatCount(1234), "1,234");
    assert.equal(formatCount(12345), "12.3K");
    assert.equal(formatChange(120, 100), "+20%");
    assert.equal(formatChange(80, 100), "−20%");
    assert.equal(formatChange(5, 0), undefined);
    assert.equal(formatMoneyTick(200, "USD"), "$2");
    assert.equal(formatMoneyTick(250, "USD"), "$2.50");
  });

  it("accepts only real YYYY-MM months", () => {
    assert.ok(isMonth("2026-10"));
    assert.ok(!isMonth("2026-13"));
    assert.ok(!isMonth("2026-1"));
    assert.ok(!isMonth("2026-10'; drop table"));
    assert.ok(!isMonth(["2026-10"]));
  });
});
