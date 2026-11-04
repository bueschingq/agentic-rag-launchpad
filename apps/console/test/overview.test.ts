import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Alert, Dashboard, DeploymentView, TenantView } from "../src/lib/metrics.ts";
import { activityChip, attentionItems, cumulative, greeting, initials, linePaths } from "../src/lib/overview.ts";

const deployment = (id: string, over: Partial<DeploymentView> = {}): DeploymentView =>
  ({
    id,
    tenantId: "t1",
    name: `Site ${id}`,
    siteUrl: `https://${id}.example`,
    status: "live",
    kbSlug: id,
    alerts: [],
    ...over,
  }) as DeploymentView;

const tenant = (deployments: DeploymentView[], alerts: Alert[] = []): TenantView =>
  ({ id: "t1", name: "Harbor View Dental", status: "active", monthlyBudgetCents: null, deployments, alerts }) as unknown as TenantView;

describe("The dashboard's needs-attention list", () => {
  it("lists each deployment Fleet flags once, with every issue, critical rows first", () => {
    const failed: Alert = { tone: "critical", text: "Last sync failed", href: "/customers/t1/deployments/b#content" };
    const quiet = deployment("a", { olderChecks: true });
    const broken = deployment("b", { alerts: [failed], olderRules: true });
    const fine = deployment("c");
    const items = attentionItems({ tenants: [tenant([quiet, broken, fine], [failed])] } as Pick<Dashboard, "tenants">);
    assert.deepEqual(
      items.map((i) => [i.key, i.tone, i.issues.map((x) => x.text), i.href]),
      [
        ["b", "critical", ["Last sync failed", "On older answering rules"], "/customers/t1/deployments/b#content"],
        ["a", "warning", ["Signed off under older checks"], "/customers/t1/deployments/a/review/up-to-date"],
      ],
    );
  });

  it("gives a customer's budget alert a row of its own, and the account's block the first row", () => {
    const over: Alert = { tone: "critical", text: "Over budget", href: "/customers/t1/edit" };
    const items = attentionItems({ tenants: [tenant([deployment("a")], [over])] }, "Agentic RAG account blocked for budget");
    assert.deepEqual(
      items.map((i) => [i.key, i.href, i.customer?.name]),
      [
        ["account", "/settings#connections", undefined],
        ["customer-t1", "/customers/t1/edit", "Harbor View Dental"],
      ],
    );
  });

  it("flags a failed stage the alerts don't already name, and sends Review to the deployment", () => {
    const d = deployment("a", { stage: { key: "failed", label: "Provisioning failed", detail: "", tone: "critical" } });
    const [item] = attentionItems({ tenants: [tenant([d])] });
    assert.equal(item?.href, "/customers/t1/deployments/a");
    assert.deepEqual(item?.issues, [{ tone: "critical", text: "Provisioning failed" }]);
    const alerted = deployment("a", {
      stage: { key: "failed", label: "Failed", detail: "", tone: "critical" },
      alerts: [{ tone: "critical", text: "Provisioning failed", href: "/customers/t1/deployments/a#provisioning" }],
    });
    assert.deepEqual(attentionItems({ tenants: [tenant([alerted])] })[0]?.issues, [{ tone: "critical", text: "Provisioning failed" }]);
  });
});

describe("The dashboard's small pieces", () => {
  it("greets a signed-in person by first name, and nobody in setup mode", () => {
    assert.equal(greeting("Dana Smith", false), "Welcome back, Dana");
    assert.equal(greeting("Setup admin", true), "Welcome back");
    assert.equal(greeting("dana@agency.com", false), "Welcome back");
  });

  it("puts two initials on the account button", () => {
    assert.equal(initials("Dana Smith"), "DS");
    assert.equal(initials("dana@agency.com"), "D");
  });

  it("labels activity by kind, with how a validation went", () => {
    assert.deepEqual(activityChip("deployment.validate", { passed: false }), { label: "Validation", tone: "warning" });
    assert.deepEqual(activityChip("deployment.signoff", {}), { label: "Sign-off", tone: "good" });
    assert.deepEqual(activityChip("content.sync", {}), { label: "Content", tone: "neutral" });
  });

  it("draws lines inside their box, and running totals", () => {
    assert.deepEqual(linePaths([0, 5, 10], 100, 10), {
      line: "M0.00,10.00L50.00,5.00L100.00,0.00",
      area: "M0.00,10.00L50.00,5.00L100.00,0.00L100,10L0,10Z",
    });
    assert.equal(linePaths([0, 0], 100, 10).line, "M0.00,10.00L100.00,10.00");
    assert.deepEqual(cumulative([1, 2, 3]), [1, 3, 6]);
  });
});
