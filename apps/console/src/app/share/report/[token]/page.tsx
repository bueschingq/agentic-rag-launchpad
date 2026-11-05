// A customer's report through a read-only share link: no sign-in, no cost, nothing else from
// the console. The month can be changed, and test traffic counted (?test=1); the link stays tied
// to its customer.

import Link from "next/link";
import { notFound } from "next/navigation";
import { ClientReport, monthName } from "@/components/client-report.tsx";
import { PrintButton } from "@/components/print-button.tsx";
import { loadSettings } from "@/lib/dashboard.ts";
import { loadReport } from "@/lib/report.ts";
import { resolveShareLink } from "@/lib/share.ts";

export const dynamic = "force-dynamic";
export const metadata = { title: "Chat report", robots: { index: false } };

type Props = { params: Promise<{ token: string }>; searchParams: Promise<{ month?: string; test?: string }> };

const thisMonth = () => new Date().toISOString().slice(0, 7);

export default async function SharedReportPage({ params, searchParams }: Props) {
  const { token } = await params;
  const { month: asked, test } = await searchParams;
  const withTest = test === "1";
  const link = await resolveShareLink("report", token);
  if (!link) notFound();
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(asked ?? "") && asked! <= thisMonth() ? asked! : thisMonth();
  const [report, settings] = await Promise.all([loadReport(link.tenantId, month, { withTest }), loadSettings()]);
  if (!report) notFound();
  const prev = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 2, 1)).toISOString().slice(0, 7);
  const next = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1)).toISOString().slice(0, 7);
  const at = (m: string, counted = withTest) => `?month=${m}${counted ? "&test=1" : ""}`;

  return (
    <main id="main" className="shell">
      <div className="page-head with-actions">
        <div>
          <h1>
            {report.tenant.visibleName}: {monthName(month)}
          </h1>
          <p className="muted">Your website chat, prepared by {settings?.partnerName || "your agency"}.</p>
        </div>
        <div className="actions no-print">
          <Link className="button secondary" href={at(prev)}>
            ← {monthName(prev)}
          </Link>
          {next <= thisMonth() && (
            <Link className="button secondary" href={at(next)}>
              {monthName(next)} →
            </Link>
          )}
          <PrintButton label="Save as PDF" />
        </div>
      </div>
      {report.empty ? (
        <p className="panel muted">No chats yet.</p>
      ) : (
        <ClientReport report={report} testHref={`${at(month, !withTest)}#test-traffic`} />
      )}
    </main>
  );
}
