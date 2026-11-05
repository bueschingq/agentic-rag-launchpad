"use server";

// Partner-wide settings: contract terms, where alerts go, and who can use the console. All of
// it is for admins; every change is audited with the person who made it.

import { auditLog, settings, users } from "@launchpad/db";
import { deliver, webhookUrlProblem } from "@launchpad/notify";
import { eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { saveAugmentNewDeployments } from "@/lib/augmentation.ts";
import { requireAdmin } from "@/lib/auth.ts";
import { enterLimit } from "@/lib/capacity.ts";
import { db } from "@/lib/db.ts";
import { publicBaseUrl } from "@/lib/env.ts";
import { parseSettingsForm } from "@/lib/settings-form.ts";
import { withSetupName } from "@/lib/setup-name.ts";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function saveSettings(form: FormData): Promise<void> {
  const actor = await requireAdmin();
  const parsed = parseSettingsForm(form);
  if ("error" in parsed) redirect(`/settings?error=${parsed.error}`);
  const { partnerName, rate, markupPercent } = parsed.value;

  await db().transaction(async (tx) => {
    const [before] = await tx.select().from(settings).where(eq(settings.id, 1));
    // Other metrics' rates (processing, storage) are kept as they are.
    const contractRates = Object.fromEntries(Object.entries(before?.contractRates ?? {}).filter(([metric]) => metric !== "nuclia_tokens"));
    if (rate !== undefined) contractRates.nuclia_tokens = rate;
    const after = { partnerName, contractRates, markupPercent };
    const terms = (s: typeof after) => ({ partnerName: s.partnerName, contractRates: s.contractRates, markupPercent: s.markupPercent });
    await tx
      .insert(settings)
      .values({ id: 1, ...after })
      .onConflictDoUpdate({ target: settings.id, set: after });
    await tx.insert(auditLog).values(
      await withSetupName({
        actorUserId: actor.id,
        action: "settings.update",
        targetType: "settings",
        targetId: "1",
        detail: { before: before ? terms(before) : null, after },
      }),
    );
  });
  revalidatePath("/", "layout");
  redirect("/settings?saved=1");
}

// The account's Knowledge Box limit, when the console can't read it (no PAT). From first-run
// setup on Fleet (next=/), it goes back there.
export async function saveKbLimit(form: FormData): Promise<void> {
  const actor = await requireAdmin();
  const back = form.get("next") === "/" ? "/" : "/settings";
  const raw = String(form.get("kbLimit") ?? "").trim();
  const limit = raw === "" ? null : Number(raw);
  if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 100_000)) redirect(`${back}?error=kbLimit`);
  await enterLimit(limit);
  await db()
    .insert(auditLog)
    .values(
      await withSetupName({ actorUserId: actor.id, action: "settings.kb-limit", targetType: "settings", targetId: "1", detail: { limit } }),
    );
  revalidatePath("/", "layout");
  redirect(`${back}?saved=1`);
}

// "Improve answers with Agentic RAG agents (pilot)": for deployments created from now on.
export async function saveAugmentation(form: FormData): Promise<void> {
  const actor = await requireAdmin();
  const outcome = await saveAugmentNewDeployments(form.get("augment") === "on", actor.id);
  if (outcome === "needs-column") redirect("/settings?error=augment#agents");
  revalidatePath("/settings");
  redirect("/settings?saved=agents#agents");
}

export async function saveAlerts(form: FormData): Promise<void> {
  const actor = await requireAdmin();
  const webhookUrl = String(form.get("alertWebhookUrl") ?? "").trim();
  const emails = String(form.get("alertEmails") ?? "")
    .split(/[\s,;]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (webhookUrl && webhookUrlProblem(webhookUrl)) redirect("/settings?error=alertWebhookUrl#alerts");
  if (emails.some((e) => !EMAIL.test(e)) || emails.length > 20) redirect("/settings?error=alertEmails#alerts");

  await db().transaction(async (tx) => {
    const [before] = await tx
      .select({ webhook: settings.alertWebhookUrl, emails: settings.alertEmails })
      .from(settings)
      .where(eq(settings.id, 1));
    const after = { alertWebhookUrl: webhookUrl || null, alertEmails: emails };
    await tx
      .insert(settings)
      .values({ id: 1, ...after })
      .onConflictDoUpdate({ target: settings.id, set: after });
    await tx.insert(auditLog).values(
      await withSetupName({
        actorUserId: actor.id,
        action: "settings.alerts",
        targetType: "settings",
        targetId: "1",
        detail: { before: before ?? null, after: { webhook: after.alertWebhookUrl, emails } },
      }),
    );
  });
  revalidatePath("/settings");
  redirect("/settings?saved=alerts#alerts");
}

export async function sendTestAlert(): Promise<void> {
  await requireAdmin();
  const [s] = await db()
    .select({ webhook: settings.alertWebhookUrl, emails: settings.alertEmails })
    .from(settings)
    .where(eq(settings.id, 1));
  const result = await deliver(
    { webhookUrl: s?.webhook, emails: s?.emails },
    { subject: "Test alert from Launchpad", text: "Alerts from your Launchpad console arrive here.", link: `${publicBaseUrl()}/settings` },
    { extra: { kind: "test" } },
  );
  const outcome = result.errors.length
    ? `failed:${encodeURIComponent(result.errors.join(" · "))}`
    : `sent:${result.delivered.join("+") || "nowhere"}`;
  redirect(`/settings?test=${outcome}#alerts`);
}

const ROLES = new Set(["partner_admin", "partner_member"]);

export async function inviteUser(form: FormData): Promise<void> {
  const actor = await requireAdmin();
  const email = String(form.get("email") ?? "")
    .trim()
    .toLowerCase();
  const name = String(form.get("name") ?? "").trim() || null;
  const role = String(form.get("role") ?? "partner_member");
  if (!EMAIL.test(email) || !ROLES.has(role)) redirect("/settings/users?error=invite");
  const [existing] = await db().select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`);
  if (existing) redirect("/settings/users?error=exists");
  const [user] = await db()
    .insert(users)
    .values({ email, name, role: role as "partner_admin" | "partner_member" })
    .returning({ id: users.id });
  await db()
    .insert(auditLog)
    .values(
      await withSetupName({
        actorUserId: actor.id,
        action: "user.invite",
        targetType: "user",
        targetId: user!.id,
        detail: { email, role },
      }),
    );
  revalidatePath("/settings/users");
  redirect("/settings/users?invited=1");
}

export async function setUserRole(userId: string, form: FormData): Promise<void> {
  const actor = await requireAdmin();
  const role = String(form.get("role") ?? "");
  if (!ROLES.has(role)) redirect("/settings/users?error=role");
  if (userId === actor.id) redirect("/settings/users?error=self");
  const [before] = await db().select({ role: users.role }).from(users).where(eq(users.id, userId));
  await db()
    .update(users)
    .set({ role: role as "partner_admin" | "partner_member" })
    .where(eq(users.id, userId));
  await db()
    .insert(auditLog)
    .values(
      await withSetupName({
        actorUserId: actor.id,
        action: "user.role",
        targetType: "user",
        targetId: userId,
        detail: { before: before?.role, after: role },
      }),
    );
  revalidatePath("/settings/users");
  redirect("/settings/users?saved=1");
}

export async function removeUser(userId: string): Promise<void> {
  const actor = await requireAdmin();
  if (userId === actor.id) redirect("/settings/users?error=self");
  const [removed] = await db().delete(users).where(eq(users.id, userId)).returning({ email: users.email });
  if (removed) {
    await db()
      .insert(auditLog)
      .values(
        await withSetupName({
          actorUserId: actor.id,
          action: "user.remove",
          targetType: "user",
          targetId: userId,
          detail: { email: removed.email },
        }),
      );
  }
  revalidatePath("/settings/users");
  redirect("/settings/users?removed=1");
}
