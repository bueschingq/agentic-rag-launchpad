// Test traffic on the costs page and its CSV (round 6, item 7): questions from a deployment's
// staging domains, or asked by partner staff, are the partner's own testing, so they come out of the
// customer price, as the client report already leaves them out (report.ts isTestQuestion). The
// usage roll-up counts tokens per deployment and day, not per question, so each day's cost is split
// by its share of test questions in the question log. Days the log doesn't cover stay the
// customer's. Shown as their own column, "Test traffic".

import { askedQuestions, deployments } from "@launchpad/db";
import { and, gte, lt } from "drizzle-orm";
import { db } from "./db.ts";
import { isoDay } from "./metrics.ts";
import { isTestQuestion } from "./report.ts";

export interface TestTraffic {
  questions: number;
  costCents: number;
}

export interface DayQuestions {
  deploymentId: string;
  day: string;
  total: number;
  test: number;
}

// Each tenant's test questions and the part of its cost they account for: each day's cost times its
// share of test questions, rounded per day. Pure.
export function testTrafficByTenant(
  usage: readonly { deploymentId: string; day: string; costCents: number | null }[],
  asked: readonly DayQuestions[],
  tenantOf: ReadonlyMap<string, string>,
): Map<string, TestTraffic> {
  const byDay = new Map(asked.map((a) => [`${a.deploymentId}|${a.day}`, a]));
  const out = new Map<string, TestTraffic>();
  const add = (tenantId: string, questions: number, costCents: number) => {
    const t = out.get(tenantId) ?? { questions: 0, costCents: 0 };
    out.set(tenantId, { questions: t.questions + questions, costCents: t.costCents + costCents });
  };
  for (const a of asked) {
    const tenantId = tenantOf.get(a.deploymentId);
    if (tenantId && a.test > 0) add(tenantId, a.test, 0);
  }
  for (const u of usage) {
    const a = byDay.get(`${u.deploymentId}|${u.day}`);
    const tenantId = tenantOf.get(u.deploymentId);
    if (!tenantId || !a?.total || !a.test || !u.costCents) continue;
    add(tenantId, 0, Math.round((u.costCents * Math.min(a.test, a.total)) / a.total));
  }
  return out;
}

// The customer price's base: the cost without its test traffic. Pure.
export const customerCostCents = (costCents: number, test: TestTraffic | undefined): number =>
  Math.max(0, costCents - (test?.costCents ?? 0));

// A month's question log by deployment and day, with its test questions.
export async function questionsByDay(month: string): Promise<DayQuestions[]> {
  const start = `${month}-01`;
  const next = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1)).toISOString().slice(0, 10);
  const [rows, ds] = await Promise.all([
    db()
      .select({
        deploymentId: askedQuestions.deploymentId,
        askedAt: askedQuestions.askedAt,
        partnerTest: askedQuestions.partnerTest,
        origin: askedQuestions.origin,
      })
      .from(askedQuestions)
      .where(and(gte(askedQuestions.askedAt, new Date(`${start}T00:00:00Z`)), lt(askedQuestions.askedAt, new Date(`${next}T00:00:00Z`)))),
    db().select({ id: deployments.id, stagingDomains: deployments.stagingDomains }).from(deployments),
  ]);
  const staging = new Map(ds.map((d) => [d.id, d.stagingDomains]));
  const days = new Map<string, DayQuestions>();
  for (const r of rows) {
    const day = isoDay(r.askedAt);
    const key = `${r.deploymentId}|${day}`;
    const d = days.get(key) ?? { deploymentId: r.deploymentId, day, total: 0, test: 0 };
    d.total += 1;
    if (isTestQuestion(r, staging.get(r.deploymentId) ?? [])) d.test += 1;
    days.set(key, d);
  }
  return [...days.values()];
}
