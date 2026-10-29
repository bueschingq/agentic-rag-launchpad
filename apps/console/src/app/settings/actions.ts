"use server";

// Saves the partner's contract terms, with an audit record of what changed. Like every admin
// route it sits behind the console's sign-in, and Next.js checks the Origin of action posts.

import { auditLog, settings } from "@launchpad/db";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db.ts";
import { parseSettingsForm } from "@/lib/settings-form.ts";

export async function saveSettings(form: FormData): Promise<void> {
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
    await tx.insert(auditLog).values({
      action: "settings.update",
      targetType: "settings",
      targetId: "1",
      detail: { before: before ? terms(before) : null, after },
    });
  });
  revalidatePath("/", "layout");
  redirect("/settings?saved=1");
}
