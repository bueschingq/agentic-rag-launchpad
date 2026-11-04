"use server";

// The price table's confirm step (round 6, item 1): a named person says the table matches the
// pricing page, saved to price_table_confirmation with the rows' hash, so it holds only while the rows
// are unchanged, and audited. Validation, the picker, the re-run and the chat check price answers
// against it. Build 8: correcting a row saves the row and nothing more, a junior fixing one row
// doesn't sign for six; confirming is its own act, and asks the price questions again (at most 4), so
// the run shows what visitors now get.

import { auditLog, deployments, type PriceTable, type PriceTableConfirmation } from "@launchpad/db";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { savePricesParagraph } from "@/lib/answers.ts";
import { currentUser } from "@/lib/auth.ts";
import { db } from "@/lib/db.ts";
import { loadDeployment } from "@/lib/provisioning.ts";
import { addPriceRow, confirmationBy, deletePriceRow, editPriceRow } from "@/lib/review.ts";
import { withSetupName } from "@/lib/setup-name.ts";
import { askPricesAgain } from "@/lib/validation.ts";

export interface PriceTableActionState {
  error?: string;
  done?: string;
}

const page = (tenantId: string, deploymentId: string) => `/customers/${tenantId}/deployments/${deploymentId}`;
const text = (value: FormDataEntryValue | null, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");

async function audit(actor: string | null, deploymentId: string, action: string, detail: Record<string, unknown>) {
  await db()
    .insert(auditLog)
    .values(await withSetupName({ actorUserId: actor, action, targetType: "deployment", targetId: deploymentId, detail }));
}

// "This matches the pricing page", for the rows the person saw (`hash`).
export async function confirmPriceTable(
  tenantId: string,
  deploymentId: string,
  hash: string,
  _previous: PriceTableActionState,
  form: FormData,
): Promise<PriceTableActionState> {
  const row = await loadDeployment(tenantId, deploymentId);
  const table = row?.deployment.priceTable;
  if (!row || !table?.rows.length) return { error: "There's no price table to confirm." };
  if (table.hash !== hash)
    return { error: "The table changed since this page loaded (the pricing page was read again): check the new rows." };
  const who = confirmationBy(await currentUser(), text(form.get("name"), 80));
  if ("error" in who) return who;
  const before = row.deployment.priceTableConfirmation;
  const edited = [...new Set([...(table.edited ?? []), ...(before?.hash === hash ? (before.edited ?? []) : [])])];
  const confirmation: PriceTableConfirmation = {
    hash,
    by: who.name,
    ...(who.by && { byUserId: who.by }),
    at: who.at,
    ...(edited.length && { edited }),
  };
  // Confirmed with a row's doubt showing: the person has answered it, and the name is on record.
  const flagged = table.rows.filter((r) => r.doubt).map((r) => r.plan);
  const { changes: _seen, ...kept } = table;
  const rows = table.rows.map((r) => {
    if (!r.doubt) return r;
    const { doubt: _answered, ...rest } = r;
    return { ...rest, doubtAccepted: true };
  });
  await db()
    .update(deployments)
    .set({ priceTableConfirmation: confirmation, priceTable: { ...kept, rows } })
    .where(and(eq(deployments.id, deploymentId), eq(deployments.tenantId, tenantId)));
  await savePricesParagraph(deploymentId).catch(() => {});
  await audit(who.by, deploymentId, "deployment.price-table.confirm", {
    hash,
    rows: table.rows.map((r) => ({
      plan: r.plan,
      amount: r.amount,
      ...(r.unit && { unit: r.unit }),
      ...(r.period && { period: r.period }),
    })),
    pages: table.pages,
    ...(flagged.length && { flagged }),
    name: who.name,
    verified: who.verified,
  });
  const asked = await askPricesAgain(deploymentId);
  revalidatePath(page(tenantId, deploymentId));
  revalidatePath(`${page(tenantId, deploymentId)}/review`);
  return {
    done: `Confirmed by ${who.name}. Price answers are checked against these ${table.rows.length} prices from now on.${asked.questions.length ? ` ${asked.questions.length} price ${asked.questions.length === 1 ? "question" : "questions"} asked again: what visitors now get is below.` : ""}`,
  };
}

// The table as a person corrected it, audited with their name. It doesn't confirm anything: the table
// waits for someone to say it matches the page, and the chat checks against the page's rows meanwhile.
// What the page read stays on the row (readAs), so a later sync of the same page leaves the correction
// standing.
async function saveCorrection(
  tenantId: string,
  deploymentId: string,
  hash: string,
  form: FormData,
  change: (table: PriceTable) => { table: PriceTable; plan: string } | { error: string },
  action: "edit" | "add" | "delete",
  done: (plan: string, table: PriceTable) => string,
): Promise<PriceTableActionState> {
  const row = await loadDeployment(tenantId, deploymentId);
  const table = row?.deployment.priceTable;
  if (!row || !table?.rows.length) return { error: "There's no price table to correct." };
  if (table.hash !== hash)
    return { error: "The table changed since this page loaded (the pricing page was read again): check the new rows." };
  const who = confirmationBy(await currentUser(), text(form.get("name"), 80));
  if ("error" in who) return who;
  const edited = change(table);
  if ("error" in edited) return edited;
  const before = row.deployment.priceTableConfirmation;
  const marked = [...new Set([...(table.edited ?? []), ...(before?.hash === hash ? (before.edited ?? []) : []), edited.plan])];
  const { changes: _seen, ...rest } = edited.table;
  await db()
    .update(deployments)
    .set({ priceTable: { ...rest, edited: marked }, priceTableConfirmation: null })
    .where(and(eq(deployments.id, deploymentId), eq(deployments.tenantId, tenantId)));
  await savePricesParagraph(deploymentId).catch(() => {});
  const brief = (rows: PriceTable["rows"]) =>
    rows.map((r) => ({
      plan: r.plan,
      amount: r.amount,
      ...(r.unit && { unit: r.unit }),
      ...(r.period && { period: r.period }),
      ...(r.addOn && { addOn: true }),
    }));
  await audit(who.by, deploymentId, `deployment.price-table.${action}`, {
    plan: edited.plan,
    before: brief(table.rows),
    after: brief(edited.table.rows),
    hash: edited.table.hash,
    name: who.name,
    verified: who.verified,
  });
  revalidatePath(page(tenantId, deploymentId));
  revalidatePath(`${page(tenantId, deploymentId)}/review`);
  return { done: done(edited.plan, edited.table) };
}

// One row corrected by hand: its plan's name, price, unit, period, and whether it's an add-on.
export async function editPriceTableRow(
  tenantId: string,
  deploymentId: string,
  hash: string,
  index: number,
  _previous: PriceTableActionState,
  form: FormData,
): Promise<PriceTableActionState> {
  return saveCorrection(
    tenantId,
    deploymentId,
    hash,
    form,
    (table) =>
      editPriceRow(table, index, {
        plan: text(form.get("plan"), 80),
        amount: text(form.get("amount"), 40),
        unit: text(form.get("unit"), 40),
        period: text(form.get("period"), 10),
        addOn: form.get("addOn") === "on",
        note: text(form.get("note"), 60),
      }),
    "edit",
    (plan, table) => `${plan} saved as ${table.rows[index]?.amount}. The table isn't confirmed yet: confirm it when every row is right.`,
  );
}

// A row the table is missing.
export async function addPriceTableRow(
  tenantId: string,
  deploymentId: string,
  hash: string,
  _previous: PriceTableActionState,
  form: FormData,
): Promise<PriceTableActionState> {
  return saveCorrection(
    tenantId,
    deploymentId,
    hash,
    form,
    (table) =>
      addPriceRow(table, {
        plan: text(form.get("plan"), 80),
        amount: text(form.get("amount"), 40),
        unit: text(form.get("unit"), 40),
        period: text(form.get("period"), 10),
        addOn: form.get("addOn") === "on",
        note: text(form.get("note"), 60),
      }),
    "add",
    (plan) => `${plan} added. The table isn't confirmed yet: confirm it when every row is right.`,
  );
}

// A row that isn't a price.
export async function deletePriceTableRow(
  tenantId: string,
  deploymentId: string,
  hash: string,
  index: number,
  _previous: PriceTableActionState,
  form: FormData,
): Promise<PriceTableActionState> {
  return saveCorrection(
    tenantId,
    deploymentId,
    hash,
    form,
    (table) => deletePriceRow(table, index),
    "delete",
    (plan) => `${plan} removed. The table isn't confirmed yet: confirm it when every row is right.`,
  );
}
