// Editing a customer after creation: its details, contacts, budget and billing reference, and
// pausing it (every one of its chats goes offline). Changes are audited with before and after.
// A change of "Name visitors see" is followed through every deployment (clientNaming).

import { auditLog, deployments, tenantContacts, tenants, users } from "@launchpad/db";
import type { ThemeInput, WidgetSettings } from "@launchpad/theme";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { type ClientNameProblem, clientNameProblems, visitorStrings } from "./client-name.ts";
import type { CustomerInput } from "./customer-form.ts";
import { db } from "./db.ts";
import { leadName, leadSubject } from "./leads.ts";
import { withSetupName } from "./setup-name.ts";
import { LEAK_PHRASES } from "./validation-rules.ts";

// The saved customer as the customer form's field values.
export async function customerFormValues(tenantId: string): Promise<Record<string, string> | undefined> {
  const [t] = await db().select().from(tenants).where(eq(tenants.id, tenantId));
  if (!t) return undefined;
  const contacts = await db()
    .select()
    .from(tenantContacts)
    .where(eq(tenantContacts.tenantId, tenantId))
    .orderBy(sql`${tenantContacts.isPrimary} desc`, asc(tenantContacts.createdAt));
  const v: Record<string, string> = {
    name: t.name,
    // Prefilled with the customer name for customers saved before it was required.
    displayName: t.displayName ?? t.name,
    language: t.language,
    budget: t.monthlyBudgetCents === null ? "" : String(t.monthlyBudgetCents / 100),
    budgetMode: t.budgetMode,
  };
  contacts.forEach((c, i) => {
    v[`contacts.${i}.name`] = c.name;
    v[`contacts.${i}.email`] = c.email;
    v[`contacts.${i}.phone`] = c.phone ?? "";
    v[`contacts.${i}.title`] = c.title ?? "";
    v[`contacts.${i}.language`] = c.language;
    v[`contacts.${i}.kbRole`] = c.kbRole ?? "";
    if (c.isPrimary) v.primary = String(i);
  });
  const b = t.billing;
  const primary = contacts.find((c) => c.isPrimary);
  if (primary && b.contactEmail === primary.email && b.contactName === primary.name) v["billing.sameAsPrimary"] = "on";
  else {
    v["billing.contactName"] = b.contactName ?? "";
    v["billing.contactEmail"] = b.contactEmail ?? "";
  }
  for (const [k, val] of Object.entries(b.address ?? {})) v[`billing.${k}`] = val ?? "";
  v["billing.method"] = b.method ?? "";
  v["billing.terms"] = b.terms ?? "";
  v["billing.poNumber"] = b.poNumber ?? "";
  v["billing.taxId"] = b.taxId ?? "";
  v["billing.externalRef"] = b.externalRef ?? "";
  return v;
}

export async function updateCustomer(tenantId: string, input: CustomerInput, actor: string | null): Promise<void> {
  await db().transaction(async (tx) => {
    const [before] = await tx.select().from(tenants).where(eq(tenants.id, tenantId));
    const contactsBefore = await tx
      .select({ email: tenantContacts.email, kbRole: tenantContacts.kbRole })
      .from(tenantContacts)
      .where(eq(tenantContacts.tenantId, tenantId));
    await tx
      .update(tenants)
      .set({
        name: input.name,
        displayName: input.displayName,
        language: input.language,
        monthlyBudgetCents: input.monthlyBudgetCents,
        budgetMode: input.budgetMode,
        billing: input.billing,
      })
      .where(eq(tenants.id, tenantId));
    await tx.delete(tenantContacts).where(eq(tenantContacts.tenantId, tenantId));
    await tx.insert(tenantContacts).values(input.contacts.map((c) => ({ ...c, tenantId, phone: c.phone ?? null, title: c.title ?? null })));
    await tx.insert(auditLog).values(
      await withSetupName({
        actorUserId: actor,
        action: "customer.update",
        targetType: "tenant",
        targetId: tenantId,
        detail: {
          before: before && {
            name: before.name,
            displayName: before.displayName,
            language: before.language,
            budgetCents: before.monthlyBudgetCents,
            budgetMode: before.budgetMode,
            contacts: contactsBefore,
          },
          after: {
            name: input.name,
            displayName: input.displayName,
            language: input.language,
            budgetCents: input.monthlyBudgetCents,
            budgetMode: input.budgetMode,
            contacts: input.contacts.map((c) => ({ email: c.email, kbRole: c.kbRole })),
          },
        },
      }),
    );
  });
}

export interface NameChange {
  at: Date;
  // What the chat called the client before and after ("Name visitors see", or the customer name a
  // customer without one fell back to).
  before: string;
  after: string;
  by: string | null;
  // In setup mode, the name typed in that session (lib/setup-name.ts), when there was one.
  typed?: string;
}

// Changes of the name visitors see, newest first, per customer: from the audit log, so a change
// after a deployment's sign-off shows as "Changed since sign-off: the client's name".
export async function nameChanges(tenantIds: readonly string[]): Promise<Map<string, NameChange[]>> {
  const out = new Map<string, NameChange[]>();
  if (!tenantIds.length) return out;
  const shown = (side: "before" | "after") =>
    sql<string | null>`coalesce(${auditLog.detail}->${side}->>'displayName', ${auditLog.detail}->${side}->>'name')`;
  const rows = await db()
    .select({
      tenantId: auditLog.targetId,
      at: auditLog.at,
      before: shown("before"),
      after: shown("after"),
      by: users.name,
      typed: sql<string | null>`${auditLog.detail}->>'name'`,
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorUserId))
    .where(
      and(
        eq(auditLog.action, "customer.update"),
        inArray(auditLog.targetId, [...tenantIds]),
        sql`${shown("before")} is distinct from ${shown("after")}`,
      ),
    )
    .orderBy(desc(auditLog.at));
  for (const r of rows) {
    if (!r.tenantId || !r.before || !r.after) continue;
    out.set(r.tenantId, [
      ...(out.get(r.tenantId) ?? []),
      { at: r.at, before: r.before, after: r.after, by: r.by, ...(r.typed && { typed: r.typed }) },
    ]);
  }
  return out;
}

export interface DeploymentNaming {
  id: string;
  name: string;
  kbId: string | null;
  systemPrompt: string;
  theme: ThemeInput;
  widgetSettings: WidgetSettings;
  language: string;
  problems: ClientNameProblem[];
}

// Each of a customer's deployments with what its prompt, widget and lead email get wrong about
// the client's name (lib/client-name.ts), and the names the client went by before. For the
// customer page's "Update all" after a change of "Name visitors see".
export async function clientNaming(tenantId: string) {
  const [t] = await db().select({ name: tenants.name, displayName: tenants.displayName }).from(tenants).where(eq(tenants.id, tenantId));
  if (!t) return undefined;
  const [rows, changes] = await Promise.all([
    db()
      .select({
        id: deployments.id,
        name: deployments.name,
        kbId: deployments.kbId,
        siteUrl: deployments.siteUrl,
        systemPrompt: deployments.systemPrompt,
        theme: deployments.theme,
        widgetSettings: deployments.widgetSettings,
        language: deployments.language,
      })
      .from(deployments)
      .where(eq(deployments.tenantId, tenantId))
      .orderBy(asc(deployments.name)),
    nameChanges([tenantId]).then((m) => m.get(tenantId) ?? []),
  ]);
  const previous = [...new Set(changes.flatMap((c) => [c.before, c.after]))].filter((n) => n !== t.displayName);
  const deploymentsNaming: DeploymentNaming[] = rows.map((d) => ({
    ...d,
    problems: clientNameProblems({
      internal: t.name,
      visible: t.displayName,
      previous,
      prompt: d.systemPrompt,
      strings: visitorStrings(d.widgetSettings),
      leadEmail: leadSubject(leadName(t.displayName, d.siteUrl)),
      leakPhrases: LEAK_PHRASES,
    }),
  }));
  return { internal: t.name, visible: t.displayName, previous, changes, deployments: deploymentsNaming };
}

export async function setCustomerPaused(tenantId: string, paused: boolean, actor: string | null): Promise<void> {
  await db()
    .update(tenants)
    .set({ status: paused ? "paused" : "active" })
    .where(eq(tenants.id, tenantId));
  await db()
    .insert(auditLog)
    .values(
      await withSetupName({
        actorUserId: actor,
        action: paused ? "customer.pause" : "customer.resume",
        targetType: "tenant",
        targetId: tenantId,
        detail: {},
      }),
    );
}
