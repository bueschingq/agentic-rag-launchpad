// Fleet view: every deployment across every customer. Usage, cost and quality columns
// arrive with the worker rollups in M4.

import { deployments, tenants } from "@launchpad/db";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db.ts";

export const dynamic = "force-dynamic";

export default async function FleetPage() {
  const rows = await db()
    .select({
      id: deployments.id,
      name: deployments.name,
      siteUrl: deployments.siteUrl,
      status: deployments.status,
      kbSlug: deployments.kbSlug,
      tenant: tenants.name,
    })
    .from(deployments)
    .innerJoin(tenants, eq(deployments.tenantId, tenants.id))
    .orderBy(desc(deployments.updatedAt));

  return (
    <main className="shell">
      <h1>Deployments</h1>
      <div className="panel">
        {rows.length === 0 ? (
          <p className="muted">No deployments yet. The provisioning wizard (M1) creates the first one from a site URL.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Customer</th>
                <th scope="col">Deployment</th>
                <th scope="col">Site</th>
                <th scope="col">Knowledge Box</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.tenant}</td>
                  <td>{r.name}</td>
                  <td>
                    <a href={r.siteUrl} rel="noreferrer" target="_blank">
                      {new URL(r.siteUrl).host}
                    </a>
                  </td>
                  <td>
                    <code>{r.kbSlug}</code>
                  </td>
                  <td>
                    <span className="status" data-status={r.status}>
                      {r.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}
