// A new customer: who they are, who to contact (and invite to their KBs), and how they pay.

import Link from "next/link";
import { CustomerForm } from "./customer-form.tsx";

export const dynamic = "force-dynamic";
export const metadata = { title: "New customer" };

type Props = { searchParams: Promise<{ next?: string }> };

export default async function NewCustomerPage({ searchParams }: Props) {
  const { next } = await searchParams;
  const fromDeployment = next === "deployment";
  return (
    <main id="main" className="shell">
      <p className="crumbs">{fromDeployment ? <Link href="/deployments/new">New deployment</Link> : <Link href="/">Fleet</Link>}</p>
      <div className="page-head">
        <h1>New customer</h1>
        <p className="muted">
          {fromDeployment ? "Saving takes you back to the deployment with this customer chosen." : "Add their sites as deployments next."}
        </p>
      </div>
      <CustomerForm next={fromDeployment ? "deployment" : undefined} />
    </main>
  );
}
