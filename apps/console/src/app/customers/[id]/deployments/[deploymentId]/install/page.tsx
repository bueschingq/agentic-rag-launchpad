// A deployment's install guide, as the client's web team will see it, plus read-only links to
// share it with them (no console sign-in needed, no keys inside).

import Link from "next/link";
import { notFound } from "next/navigation";
import { CopyButton } from "@/components/copy-button.tsx";
import { InstallCheckForm } from "@/components/install-check.tsx";
import { InstallGuide } from "@/components/install-guide.tsx";
import { loadSettings } from "@/lib/dashboard.ts";
import { publicBaseUrl } from "@/lib/env.ts";
import { loadDeployment } from "@/lib/provisioning.ts";
import { activeShareLinks } from "@/lib/share.ts";
import { checkInstallAction, revokeGuideLink, shareGuide } from "./actions.ts";

export const dynamic = "force-dynamic";
export const metadata = { title: "Install guide" };

type Props = { params: Promise<{ id: string; deploymentId: string }>; searchParams: Promise<{ link?: string; revoked?: string }> };

export default async function InstallPage({ params, searchParams }: Props) {
  const { id, deploymentId } = await params;
  const { link, revoked } = await searchParams;
  const row = await loadDeployment(id, deploymentId);
  if (!row) notFound();
  const d = row.deployment;
  // Nothing to install, or share, before the chat exists.
  if (!d.kbId || (d.status !== "live" && d.status !== "paused")) {
    return (
      <main id="main" className="shell">
        <p className="crumbs">
          <Link href={`/customers/${id}/deployments/${d.id}`}>{d.name}</Link>
        </p>
        <h1>Install guide</h1>
        <p className="notice" data-tone="warning" role="status">
          Not ready yet: the install guide and its share link are available once provisioning succeeds.
        </p>
      </main>
    );
  }
  const [settings, links] = await Promise.all([loadSettings(), activeShareLinks("install", id, d.id)]);
  // What the client's team reads names the client as visitors see it, never the partner's label.
  const client = row.visibleName?.trim() || "the client";

  return (
    <main id="main" className="shell">
      <p className="crumbs">
        <Link href={`/customers/${id}/deployments/${d.id}#go-live`}>{d.name}</Link>
      </p>
      <div className="page-head with-actions">
        <div>
          <h1>Install guide</h1>
          <p className="muted">
            For {client}'s web team. Print it, or share a read-only link.
            {!row.visibleName?.trim() && (
              <>
                {" "}
                <Link href={`/customers/${id}/edit#displayName`}>Set Name visitors see</Link> so it names the client.
              </>
            )}
          </p>
        </div>
        <form action={shareGuide.bind(null, id, d.id)}>
          <button className="button" type="submit">
            Share a link
          </button>
        </form>
      </div>

      <section className="panel" id="share" aria-labelledby="share-title">
        <h2 id="share-title">Shared links</h2>
        {link && (
          <div className="notice" role="status">
            <p>New link, valid for 90 days. Anyone with it can read the guide and run the check; it holds no keys.</p>
            <p>
              <code className="wrap">{link}</code> <CopyButton text={link} label="Copy link" />
            </p>
          </div>
        )}
        {revoked && (
          <p className="notice" role="status">
            Link revoked: it no longer opens.
          </p>
        )}
        {links.length ? (
          <ul className="plain">
            {links.map((l) => (
              <li key={l.id}>
                Shared {l.createdAt.toISOString().slice(0, 10)}, expires {l.expiresAt.toISOString().slice(0, 10)}{" "}
                <form action={revokeGuideLink.bind(null, id, d.id, l.id)} className="inline">
                  <button type="submit" className="link-button">
                    Revoke
                  </button>
                </form>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">None yet.</p>
        )}
      </section>

      <InstallGuide
        d={{ ...d, avatar: d.widgetSettings.avatar }}
        customer={client}
        partner={settings?.partnerName ?? ""}
        consoleOrigin={publicBaseUrl()}
        check={<InstallCheckForm siteUrl={d.siteUrl} run={checkInstallAction.bind(null, id, d.id)} />}
      />
    </main>
  );
}
