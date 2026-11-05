// A customer's monthly report, for their marketing team: share a read-only link (never shows
// cost) or print it to PDF, under the name visitors see. The cost line is the console's own, off
// unless asked for. "Not a content gap" hides a question from the lists here and on shared links.
// Test traffic stays out of the figures unless included (?test=1).

import { cookies } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ClientReport, monthName } from "@/components/client-report.tsx";
import { CopyButton } from "@/components/copy-button.tsx";
import { PrintButton } from "@/components/print-button.tsx";
import { currency } from "@/lib/env.ts";
import { loadReport } from "@/lib/report.ts";
import { activeShareLinks } from "@/lib/share.ts";
import { revokeReportLink, setReportQuestionHidden, shareReport } from "./actions.ts";

export const dynamic = "force-dynamic";
export const metadata = { title: "Report" };

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ month?: string; cost?: string; test?: string; link?: string; revoked?: string; hid?: string }>;
};

const thisMonth = () => new Date().toISOString().slice(0, 7);

export default async function ReportPage({ params, searchParams }: Props) {
  const { id } = await params;
  const query = await searchParams;
  const month = query.month && /^\d{4}-(0[1-9]|1[0-2])$/.test(query.month) ? query.month : thisMonth();
  // Presenting to the client (the Present button): the partner's cost stays hidden.
  const presenting = (await cookies()).get("lp_presenting")?.value === id;
  const showCost = query.cost === "1" && !presenting;
  const withTest = query.test === "1";
  const report = /^[0-9a-f-]{36}$/i.test(id) ? await loadReport(id, month, { withTest }) : undefined;
  if (!report) notFound();
  const links = await activeShareLinks("report", id);
  const prev = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 2, 1)).toISOString().slice(0, 7);
  const next = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1)).toISOString().slice(0, 7);
  // The report for a month, keeping the cost line and test traffic as they are unless told otherwise.
  const at = (m: string, o: { cost?: boolean; test?: boolean } = {}) =>
    `?month=${m}${(o.cost ?? showCost) ? "&cost=1" : ""}${(o.test ?? withTest) ? "&test=1" : ""}`;

  return (
    <main id="main" className="shell">
      <p className="crumbs no-print">
        <Link href={`/customers/${id}`}>{report.tenant.name}</Link>
      </p>
      <div className="page-head with-actions">
        <div>
          <h1>
            {report.tenant.visibleName}: {monthName(month)}
          </h1>
          <p className="muted">The website chat: what visitors asked, what went unanswered, and what they did next.</p>
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
          <PrintButton label="Export PDF" />
          <a className="button secondary" href={`/customers/${id}/report/export?month=${month}${withTest ? "&test=1" : ""}`} download>
            Export CSV
          </a>
          <form action={shareReport.bind(null, id, month, withTest)}>
            <button className="button" type="submit">
              Share a link
            </button>
          </form>
        </div>
      </div>

      <section className="panel no-print" id="share" aria-labelledby="share-title">
        <h2 id="share-title">Sharing</h2>
        {query.link && (
          <div className="notice" role="status">
            <p>New link, valid for 90 days. It shows this report without any cost, and nothing else in the console.</p>
            <p>
              <code className="wrap">{query.link}</code> <CopyButton text={query.link} label="Copy link" />
            </p>
          </div>
        )}
        {query.revoked && (
          <p className="notice" role="status">
            Link revoked: it no longer opens.
          </p>
        )}
        {links.length > 0 && (
          <ul className="plain">
            {links.map((l) => (
              <li key={l.id}>
                Shared {l.createdAt.toISOString().slice(0, 10)}, expires {l.expiresAt.toISOString().slice(0, 10)}{" "}
                <form action={revokeReportLink.bind(null, id, l.id)} className="inline">
                  <button type="submit" className="link-button">
                    Revoke
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
        <p className="help" hidden={presenting}>
          {showCost ? (
            <Link href={at(month, { cost: false })}>Hide the cost line</Link>
          ) : (
            <Link href={at(month, { cost: true })}>Show the cost line (console and PDF only)</Link>
          )}
        </p>
      </section>

      {query.hid && (
        <p className="notice no-print" role="status">
          Hidden from the report and from shared links. It's listed under Hidden from the report, to show it again.
        </p>
      )}
      {report.empty ? (
        <p className="panel muted">This customer has no deployments yet.</p>
      ) : (
        <ClientReport
          report={report}
          cost={showCost ? { currency: currency() } : undefined}
          testHref={`${at(month, { test: !withTest })}#test-traffic`}
          controls={{
            hide: (question) => setReportQuestionHidden.bind(null, id, month, question, true),
            show: (question) => setReportQuestionHidden.bind(null, id, month, question, false),
          }}
        />
      )}
    </main>
  );
}
