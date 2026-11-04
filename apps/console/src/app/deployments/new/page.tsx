// A new deployment: one customer site with its own Knowledge Box, keys and system prompt. The
// site address brings up the content plan (from the sitemaps) and a scan of the site; Create
// applies the plan, then the first sync starts as soon as the Knowledge Box is provisioned.

import { tenants } from "@launchpad/db";
import Link from "next/link";
import { currentUser, isAdmin } from "@/lib/auth.ts";
import { capacityMessage, kbAllowance, waitingForKb } from "@/lib/capacity.ts";
import { agenticRagConnection } from "@/lib/connections.ts";
import { db } from "@/lib/db.ts";
import { loadCustomerOptions } from "@/lib/provisioning.ts";
import { DeploymentForm } from "./deployment-form.tsx";

export const dynamic = "force-dynamic";
export const metadata = { title: "New deployment" };

type Props = { searchParams: Promise<{ customer?: string }> };

export default async function NewDeploymentPage({ searchParams }: Props) {
  const { customer } = await searchParams;
  const [options, names, connection, user] = await Promise.all([
    loadCustomerOptions(),
    // The name visitors see, for the prompt template: never the partner's internal name.
    db().select({ id: tenants.id, displayName: tenants.displayName }).from(tenants),
    agenticRagConnection(),
    currentUser(),
  ]);
  const shown = new Map(names.map((n) => [n.id, n.displayName]));
  const customers = options.map((c) => ({ ...c, displayName: shown.get(c.id) ?? null }));
  const allowance = connection.ok ? await kbAllowance() : undefined;
  // Deployments here still waiting for a Knowledge Box count against the room left.
  const waiting = allowance ? await waitingForKb() : 0;
  const preselected = customers.find((c) => c.id === customer);
  return (
    <main id="main" className="shell">
      <p className="crumbs">
        {preselected ? <Link href={`/customers/${preselected.id}`}>{preselected.name}</Link> : <Link href="/">Fleet</Link>}
      </p>
      <div className="page-head">
        <h1>New deployment</h1>
        <p className="muted">
          Creates a Knowledge Box locked to the site, its keys and its prompt. The content plan below decides which pages the first sync
          takes; it starts as soon as the Knowledge Box exists.
        </p>
      </div>
      {!connection.ok && (
        <p className="notice" data-tone="critical" role="alert">
          Launchpad isn't connected to Agentic RAG yet, so deployments can't be created.{" "}
          {isAdmin(user) ? (
            <>
              {connection.problem} <Link href="/settings">Settings</Link> shows the connection.
            </>
          ) : (
            "Ask an admin to add the account key."
          )}
        </p>
      )}
      <DeploymentForm
        customers={customers}
        customerId={preselected?.id}
        {...(allowance && { capacity: { ...capacityMessage(allowance, waiting), full: allowance.left === 0 } })}
      />
    </main>
  );
}
