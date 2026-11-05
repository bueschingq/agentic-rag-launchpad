"use server";

// Creates a customer with its contacts and billing details. Like every admin route it sits
// behind the console's sign-in, and Next.js checks the Origin of action posts.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { actorId } from "@/lib/auth.ts";
import { parseCustomerForm } from "@/lib/customer-form.ts";
import { type FormState, failed } from "@/lib/form-state.ts";
import { createCustomer } from "@/lib/provisioning.ts";

export async function saveCustomer(previous: FormState, form: FormData): Promise<FormState> {
  const parsed = parseCustomerForm(form);
  if ("errors" in parsed) return failed(previous, form, parsed.errors);
  const id = await createCustomer(parsed.value, await actorId());
  revalidatePath("/", "layout");
  // Opened from the deployment form: go back to it with the new customer chosen.
  redirect(form.get("next") === "deployment" ? `/deployments/new?customer=${id}` : `/customers/${id}?created=1`);
}
