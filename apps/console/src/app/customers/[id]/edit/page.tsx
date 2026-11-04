// Editing a customer: the same form as a new one, filled in. Contacts with Knowledge Box access
// are invited to deployments provisioned from now on.

import Link from "next/link";
import { notFound } from "next/navigation";
import { customerFormValues } from "@/lib/customers.ts";
import { CustomerForm } from "../../new/customer-form.tsx";
import { saveEditedCustomer } from "./actions.ts";

export const dynamic = "force-dynamic";
export const metadata = { title: "Edit customer" };

type Params = { params: Promise<{ id: string }> };

export default async function EditCustomerPage({ params }: Params) {
  const { id } = await params;
  const values = /^[0-9a-f-]{36}$/i.test(id) ? await customerFormValues(id) : undefined;
  if (!values) notFound();
  return (
    <main id="main" className="shell">
      <p className="crumbs">
        <Link href={`/customers/${id}`}>{values.name}</Link>
      </p>
      <div className="page-head">
        <h1>Edit {values.name}</h1>
        <p className="muted">Contacts with Knowledge Box access are invited to deployments provisioned from now on.</p>
      </div>
      <CustomerForm action={saveEditedCustomer.bind(null, id)} initial={{ errors: {}, values, attempt: 0 }} submitLabel="Save customer" />
    </main>
  );
}
