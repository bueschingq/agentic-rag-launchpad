// The client report's content: shown in the console (with an optional cost line, and controls
// to hide a question that isn't a content gap) and through a read-only share link (never with
// cost or controls). Printable: the browser's Save as PDF gives the PDF. Test traffic from staging
// domains is a line of its own, with a switch to count it, on both.

import Link from "next/link";
import { formatCount, formatMoney, formatPercent } from "@/lib/format.ts";
import { contactClicks, type GroupedQuestion, languageCounts, type loadReport, qualityWords, reportFunnel } from "@/lib/report.ts";

// How a visitor reached a person (the widget's contact_type).
const HANDOFF_LABELS: Record<string, string> = { phone: "Phone", email: "Email", link: "Contact page", form: "Contact form opened" };

type Report = Extract<NonNullable<Awaited<ReturnType<typeof loadReport>>>, { empty: false }>;

// Server actions bound to one question: hide it from the report, or show it again.
export interface ReportControls {
  hide: (question: string) => () => Promise<void>;
  show: (question: string) => () => Promise<void>;
}

const monthName = (month: string) =>
  new Date(`${month}-01T00:00:00Z`).toLocaleString("en", { month: "long", year: "numeric", timeZone: "UTC" });

const dayName = (d: Date) => d.toLocaleString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const time = (d: Date) => d.toISOString().slice(11, 16);

// "Figures to 14:15 UTC", with the day when it isn't today.
function figuresTo(at: Date): string {
  const today = new Date().toISOString().slice(0, 10) === at.toISOString().slice(0, 10);
  return `Figures to ${today ? "" : `${dayName(at)}, `}${time(at)} UTC`;
}

function HideButton({ action, label }: { action: () => Promise<void>; label: string }) {
  return (
    <form action={action} className="inline no-print">
      <button type="submit" className="link-button">
        {label}
      </button>
    </form>
  );
}

function QuestionList({ items, controls }: { items: GroupedQuestion[]; controls?: ReportControls }) {
  return (
    <ol className="report-list">
      {items.map((q) => (
        <li key={q.question}>
          <span>{q.question}</span> <span className="muted">{q.count}×</span>
          {controls && (
            <>
              {" "}
              <HideButton action={controls.hide(q.question)} label="Not a content gap" />
            </>
          )}
        </li>
      ))}
    </ol>
  );
}

// "Test traffic: 12 questions, not counted", and the switch that counts them or leaves them out.
function TestTraffic({ test, href }: { test: Report["test"]; href?: string }) {
  if (!test.questions) return null;
  const n = `${formatCount(test.questions)} question${test.questions === 1 ? "" : "s"}`;
  return (
    <p className="help" id="test-traffic">
      Test traffic: {n}, {test.included ? "included in these figures" : "not counted"}. Asked while testing on a staging site.
      {href && (
        <>
          {" "}
          <Link className="no-print" href={href}>
            {test.included ? "Leave test traffic out" : "Include test traffic"}
          </Link>
        </>
      )}
    </p>
  );
}

export function ClientReport({
  report,
  cost,
  controls,
  testHref,
}: {
  report: Report;
  cost?: { currency: string };
  controls?: ReportControls;
  // The same report with test traffic switched the other way.
  testHref?: string;
}) {
  const rated = report.thumbs.up + report.thumbs.down;
  const answeredShare = report.logged ? report.answered / report.logged : 0;
  // Counted, but not yet read from the question log (the worker reads it every 15 minutes).
  const pending = report.logged === 0 && report.questions > 0;
  const rule =
    report.rule.earlier === "all"
      ? "Counted with the earlier rule."
      : report.rule.earlier === "some" && report.rule.since
        ? `Questions before ${dayName(report.rule.since)} are counted with the earlier rule.`
        : "";
  return (
    <div className="report">
      {report.figuresTo && (
        <p className="help">
          {figuresTo(report.figuresTo)}. Questions arrive within 15 minutes of being asked; chats opened and languages count at once.
        </p>
      )}
      <section className="tiles" aria-label={`${monthName(report.month)} in numbers`}>
        <div className="tile">
          <p className="tile-label">Questions asked</p>
          <p className="tile-value">{formatCount(report.questions)}</p>
          <p className="tile-detail">{report.opens ? `${formatCount(report.opens)} chats opened` : " "}</p>
        </div>
        <div className="tile">
          <p className="tile-label">Answered from the site</p>
          <p className="tile-value">{report.logged ? formatPercent(answeredShare) : "–"}</p>
          <p className="tile-detail">
            {pending ? "Details arrive within 15 minutes" : `${formatCount(report.unanswered)} with no answer on the site`}
            {rule && (
              <>
                <br />
                {rule}
              </>
            )}
          </p>
        </div>
        <div className="tile">
          <p className="tile-label">Visitors' ratings</p>
          <p className="tile-value">{rated ? formatPercent(report.thumbs.up / rated) : "–"}</p>
          <p className="tile-detail">{rated ? `${report.thumbs.up} helpful, ${report.thumbs.down} not` : "No ratings yet"}</p>
        </div>
        <div className="tile">
          <p className="tile-label">Leads and handoffs</p>
          <p className="tile-value">{formatCount(report.leads + contactClicks(report))}</p>
          <p className="tile-detail">
            {report.leads} contact form{report.leads === 1 ? "" : "s"} sent, {contactClicks(report)} contact click
            {contactClicks(report) === 1 ? "" : "s"}
          </p>
        </div>
      </section>
      {report.gapsNote && (
        <p className="help" id="gaps-rule">
          {report.gapsNote}
        </p>
      )}
      <TestTraffic test={report.test} href={testHref} />

      <section className="panel" aria-labelledby="funnel">
        <h2 id="funnel">From chat to lead</h2>
        <ol className="plain funnel">
          {reportFunnel(report).map((step) => (
            <li key={step.label}>
              {step.label}: <strong>{formatCount(step.count)}</strong>
            </li>
          ))}
        </ol>
        <p className="help">
          A chat can ask several questions, so these are the month's counts at each step, not a share of the step before.
        </p>
      </section>

      <section className="panel" aria-labelledby="quality-words">
        <h2 id="quality-words">Answer quality</h2>
        <p>{qualityWords(report.quality.now, report.quality.before)}</p>
        {cost && (
          <p className="muted">
            Cost this month: {formatMoney(report.costCents, cost.currency)} (shown in the console only; shared links never show it).
          </p>
        )}
      </section>

      <section className="panel" aria-labelledby="top">
        <h2 id="top">What visitors asked most</h2>
        {report.top.length ? (
          <ol className="report-list">
            {report.top.map((q) => (
              <li key={q.question}>
                <span>{q.question}</span>{" "}
                <span className="muted">
                  {q.count}×{q.answered < q.count && `, ${q.count - q.answered} unanswered`}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">
            {pending ? "The questions themselves arrive within 15 minutes of being asked." : "No questions this month."}
          </p>
        )}
        <p className="help">
          Identical wordings are counted together (ignoring case and punctuation). Email addresses and phone numbers are masked.
        </p>
      </section>

      <div className="report-columns">
        <section className="panel" aria-labelledby="gaps">
          <h2 id="gaps">Content gaps: asked, but not answered on the site</h2>
          {report.gaps.length ? (
            <>
              <QuestionList items={report.gaps} controls={controls} />
              <p className="help">Adding or clarifying pages on these topics lets the chatbot answer them.</p>
            </>
          ) : (
            <p className="muted">
              {pending ? "Not known yet." : report.logged ? "Every question had an answer on the site." : "No questions this month."}
            </p>
          )}
        </section>

        <section className="panel" aria-labelledby="not-helpful">
          <h2 id="not-helpful">Rated not helpful</h2>
          {report.notHelpful.length ? (
            <>
              <QuestionList items={report.notHelpful} controls={controls} />
              <p className="help">Visitors gave these answers a thumbs-down: the page behind them may be unclear or out of date.</p>
            </>
          ) : (
            <p className="muted">{rated ? "No answer was rated not helpful." : "No ratings yet."}</p>
          )}
        </section>
      </div>

      {controls && report.missed.length > 0 && (
        <section className="panel no-print" id="missed" aria-labelledby="missed-title">
          <h2 id="missed-title">Answers that missed what the site says</h2>
          <p className="help">
            The chat said the site doesn't have these, and the site's own pages do (checked overnight against its key pages). Counted as
            unanswered, but no content gap: run validation, and ask each again. Shown in the console only.
          </p>
          <QuestionList items={report.missed} />
        </section>
      )}

      {controls && report.hidden.length > 0 && (
        <section className="panel no-print" id="hidden" aria-labelledby="hidden-title">
          <h2 id="hidden-title">Hidden from the report</h2>
          <p className="help">Marked "Not a content gap": left out of every list here and on shared links. Totals still count them.</p>
          <ul className="plain">
            {report.hidden.map((q) => (
              <li key={q.question}>
                {q.question} <span className="muted">{q.count}×</span> <HideButton action={controls.show(q.question)} label="Show again" />
              </li>
            ))}
          </ul>
        </section>
      )}

      {(report.ctas.length > 0 || report.handoffs.length > 0 || report.languages.length > 0) && (
        <section className="panel" aria-labelledby="actions">
          <h2 id="actions">What visitors did</h2>
          <div className="report-columns">
            {report.ctas.length > 0 && (
              <div>
                <h3 className="h4">Buttons clicked</h3>
                <ul className="plain">
                  {report.ctas.map((c) => (
                    <li key={c.label}>
                      {c.label}: {formatCount(c.count)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {report.handoffs.length > 0 && (
              <div>
                <h3 className="h4">Contacts used</h3>
                <ul className="plain">
                  {report.handoffs.map((h) => (
                    <li key={h.label}>
                      {HANDOFF_LABELS[h.label] ?? "Contact page"}: {formatCount(h.count)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {report.languages.length > 0 && (
              <div>
                <h3 className="h4">Languages</h3>
                <ul className="plain">
                  {languageCounts(report).map((l) => (
                    <li key={l.label}>
                      {l.label}: {formatCount(l.count)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

export { monthName };
