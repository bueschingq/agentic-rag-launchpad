// The install guide through a read-only share link: no sign-in, no keys, and the installation
// check, so the client's web team can confirm their work themselves.

import { deployments, tenants } from "@launchpad/db";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { InstallCheckForm } from "@/components/install-check.tsx";
import { InstallGuide } from "@/components/install-guide.tsx";
import { loadSettings } from "@/lib/dashboard.ts";
import { db } from "@/lib/db.ts";
import { publicBaseUrl } from "@/lib/env.ts";
import { checkDeploymentInstall } from "@/lib/install.ts";
import { resolveShareLink } from "@/lib/share.ts";

export const dynamic = "force-dynamic";
export const metadata = { title: "Install guide", robots: { index: false } };

type Props = { params: Promise<{ token: string }> };

async function checkShared(token: string, url: string) {
  "use server";
  const link = await resolveShareLink("install", token);
  if (!link?.deploymentId) return { error: "This link has expired or was revoked." };
  return checkDeploymentInstall(link.deploymentId, url, { anonymous: true });
}

export default async function SharedInstallPage({ params }: Props) {
  const { token } = await params;
  const link = await resolveShareLink("install", token);
  if (!link?.deploymentId) notFound();
  const [row] = await db()
    .select({ d: deployments, visible: tenants.displayName })
    .from(deployments)
    .innerJoin(tenants, eq(tenants.id, deployments.tenantId))
    .where(eq(deployments.id, link.deploymentId));
  if (!row) notFound();
  const settings = await loadSettings();
  // The client's team reads this: the name visitors see, never the partner's own label.
  const customer = row.visible?.trim() || "the client";

  return (
    <main id="main" className="shell">
      <div className="page-head">
        <h1>Installing the chat on {new URL(row.d.siteUrl).host}</h1>
        <p className="muted">
          Prepared by {settings?.partnerName || "your agency"} for {customer}. This page is read-only.
        </p>
      </div>
      {row.d.kbId && (row.d.status === "live" || row.d.status === "paused") ? (
        <InstallGuide
          d={{ ...row.d, avatar: row.d.widgetSettings.avatar }}
          customer={customer}
          partner={settings?.partnerName ?? ""}
          consoleOrigin={publicBaseUrl()}
          check={<InstallCheckForm siteUrl={row.d.siteUrl} run={checkShared.bind(null, token)} />}
        />
      ) : (
        <p className="notice" data-tone="warning" role="status">
          Not ready yet: this chat hasn't been set up. {settings?.partnerName || "Your agency"} will send this link again once it is.
        </p>
      )}
    </main>
  );
}
