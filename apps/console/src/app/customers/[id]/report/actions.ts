"use server";

// Share or revoke read-only links to a customer's report, and hide questions that aren't content gaps.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { actorId } from "@/lib/auth.ts";
import { setQuestionHidden } from "@/lib/report.ts";
import { createShareLink, revokeShareLink } from "@/lib/share.ts";

// The link opens on the month shown, with test traffic as shown; the client can switch it.
export async function shareReport(tenantId: string, month: string, withTest = false): Promise<void> {
  const link = await createShareLink("report", tenantId, null, await actorId());
  const query = `?month=${month}${withTest ? "&test=1" : ""}`;
  revalidatePath(`/customers/${tenantId}/report`);
  redirect(`/customers/${tenantId}/report${query}&link=${encodeURIComponent(`${link}${query}`)}#share`);
}

export async function revokeReportLink(tenantId: string, linkId: string): Promise<void> {
  await revokeShareLink(linkId, tenantId, await actorId());
  revalidatePath(`/customers/${tenantId}/report`);
  redirect(`/customers/${tenantId}/report?revoked=1#share`);
}

// "Not a content gap": hide a question from the report's lists and the shared link, or show it again.
export async function setReportQuestionHidden(tenantId: string, month: string, question: string, hidden: boolean): Promise<void> {
  const safeMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : new Date().toISOString().slice(0, 7);
  await setQuestionHidden(tenantId, safeMonth, String(question).slice(0, 1000), hidden, await actorId());
  revalidatePath(`/customers/${tenantId}/report`);
  redirect(`/customers/${tenantId}/report?month=${safeMonth}${hidden ? "&hid=1" : ""}#${hidden ? "hidden" : "gaps"}`);
}
