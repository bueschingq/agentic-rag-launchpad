"use client";

// The price table's confirm step, on the deployment page and on Review (round 6, item 1): the
// prices read from the pricing page, an Open link to each pricing page, "This matches the pricing
// page" with the person's name, and a correction per row. Checking the page once replaces most
// per-answer "I checked it" clicks: every price answer is checked against the confirmed table.
// Build 8: a correction saves the row; confirming is its own act, offered with flagged rows only in
// so many words, and it asks the price questions again, whose answers show here.

import type { PriceTable, PriceTableConfirmation } from "@launchpad/db";
import { planNameDoubt, rowTerms, shownQualifiers } from "@launchpad/theme";
import { Fragment, startTransition, useActionState, useEffect, useId, useRef, useState } from "react";
import { useTypedName } from "@/components/typed-name.ts";
import { Badge } from "@/components/ui.tsx";
import type { PriceTableState } from "@/lib/review.ts";
import type { PriceTableActionState } from "./actions.ts";

type Action = (previous: PriceTableActionState, form: FormData) => Promise<PriceTableActionState>;

const path = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
};
const when = (at: string) => `${at.slice(0, 16).replace("T", " ")} UTC`;

// What the chat does in the meantime, said plainly.
const UNCONFIRMED_CHAT =
  "Until it's confirmed, the chat only catches a figure given to the wrong plan, and can't give these prices itself.";

function NameField({ id }: { id: string }) {
  const [name, setName] = useTypedName();
  return (
    <div className="field inline-field">
      <label htmlFor={id}>Your name</label>
      <input id={id} name="name" autoComplete="name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
    </div>
  );
}

// What a save said. Keyboard focus goes to it, since what had focus may be gone (round 7: focus fell to
// BODY after each save, and the next keystrokes landed elsewhere on the page).
function Result({ state }: { state: PriceTableActionState }) {
  const line = useRef<HTMLParagraphElement>(null);
  const said = state.error ?? state.done;
  useEffect(() => {
    if (said) line.current?.focus();
  }, [said]);
  if (state.error)
    return (
      <p ref={line} tabIndex={-1} className="notice" data-tone="critical" role="alert">
        {state.error}
      </p>
    );
  if (state.done)
    return (
      <p ref={line} tabIndex={-1} className="notice" data-tone="good" role="status">
        {state.done}
      </p>
    );
  return null;
}

// Tells the card when a form below it has saved, to close the form and say so in a place that stays.
function useSaved(state: PriceTableActionState, onSaved: (done: string) => void) {
  const told = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (state.done && state.done !== told.current) {
      told.current = state.done;
      onSaved(state.done);
    }
  }, [state.done, onSaved]);
}

type Row = PriceTable["rows"][number];

// The fields a row is typed in, for a correction and for a new row.
function RowFields({ id, row, setupMode }: { id: string; row?: Row; setupMode: boolean }) {
  return (
    <>
      <div className="field">
        <label htmlFor={`${id}-plan`}>Plan's name, as the page shows it</label>
        <input id={`${id}-plan`} name="plan" required maxLength={80} defaultValue={row?.plan ?? ""} />
      </div>
      <div className="field">
        <label htmlFor={`${id}-amount`}>Price, as the page shows it</label>
        <input id={`${id}-amount`} name="amount" required maxLength={40} defaultValue={row?.amount ?? ""} />
      </div>
      <div className="field">
        <label htmlFor={`${id}-unit`}>Per (optional)</label>
        <input id={`${id}-unit`} name="unit" maxLength={40} defaultValue={row?.unit ?? ""} placeholder="per user" />
      </div>
      <div className="field">
        <label htmlFor={`${id}-period`}>Billed</label>
        <select id={`${id}-period`} name="period" defaultValue={row?.period ?? ""}>
          <option value="">Not stated</option>
          <option value="month">Monthly</option>
          <option value="year">Yearly</option>
          <option value="once">Once</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor={`${id}-note`}>What tells this price apart (optional)</label>
        <input
          id={`${id}-note`}
          name="note"
          maxLength={60}
          defaultValue={row ? shownQualifiers(row).join(", ") : ""}
          placeholder="billed annually, 50,000 emails"
        />
      </div>
      <div className="field">
        <label htmlFor={`${id}-addon`}>
          <input id={`${id}-addon`} type="checkbox" name="addOn" defaultChecked={Boolean(row?.addOn)} /> It's an add-on, not a plan
        </label>
      </div>
      {setupMode && <NameField id={`${id}-name`} />}
    </>
  );
}

// One row's correction, under the table at full width: inside a table cell a phone had to scroll
// sideways through a tall row (round 7, 390 px).
function RowEdit({
  action,
  remove,
  setupMode,
  row,
  onSaved,
  onClose,
}: {
  action: Action;
  remove: Action;
  setupMode: boolean;
  row: Row;
  onSaved: (done: string) => void;
  onClose: () => void;
}) {
  const [state, run, pending] = useActionState(action, {});
  const [removed, runRemove, removing] = useActionState(remove, {});
  useSaved(state, onSaved);
  useSaved(removed, onSaved);
  const id = useId();
  const label = `${row.plan} ${row.amount}`;
  const first = useRef<HTMLFormElement>(null);
  useEffect(() => {
    first.current?.querySelector("input")?.focus();
  }, []);
  return (
    <div className="row-edit">
      <p>
        <strong>Correct {label}</strong>
      </p>
      <form
        ref={first}
        aria-label={`Correct ${label}`}
        onSubmit={(e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          startTransition(() => run(form));
        }}
      >
        <Result state={state.error ? state : {}} />
        <RowFields id={id} row={row} setupMode={setupMode} />
        <button type="submit" className="button secondary" disabled={pending}>
          {pending ? "Saving…" : "Save the row"}
        </button>
      </form>
      <form
        aria-label={`Remove ${label}`}
        onSubmit={(e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          startTransition(() => runRemove(form));
        }}
      >
        <Result state={removed.error ? removed : {}} />
        {setupMode && <NameField id={`${id}-remove-name`} />}
        <button type="submit" className="button secondary" disabled={removing}>
          {removing ? "Removing…" : "Remove the row"}
        </button>{" "}
        <button type="button" className="button secondary" onClick={onClose}>
          Cancel
        </button>
      </form>
    </div>
  );
}

function RowAdd({ action, setupMode, onSaved }: { action: Action; setupMode: boolean; onSaved: (done: string) => void }) {
  const [state, run, pending] = useActionState(action, {});
  const [open, setOpen] = useState(false);
  useSaved(state, (done) => {
    setOpen(false);
    onSaved(done);
  });
  const id = useId();
  return (
    <details className="row-edit" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Add a row</summary>
      <form
        aria-label="Add a row"
        onSubmit={(e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          startTransition(() => run(form));
        }}
      >
        <Result state={state.error ? state : {}} />
        <RowFields id={id} setupMode={setupMode} />
        <button type="submit" className="button secondary" disabled={pending}>
          {pending ? "Saving…" : "Add the row"}
        </button>
      </form>
    </details>
  );
}

export function PriceTableCard({
  table,
  confirmation,
  state,
  confirm,
  edit,
  remove = [],
  add,
  titles = {},
  note,
  reading = false,
  setupMode,
  headingLevel = 3,
}: {
  table: PriceTable | null;
  confirmation: PriceTableConfirmation | null;
  state: PriceTableState;
  confirm: Action;
  // One action per row, by index.
  edit: Action[];
  // Removing a row, by index, and adding one.
  remove?: Action[];
  add?: Action;
  // The pricing pages' titles, by address: a row named after its page is flagged.
  titles?: Record<string, string>;
  // With no rows: what was found (noPriceTableNote, by the table's gap).
  note: string;
  // The first sync is still running, so nothing is known yet: sign-off's "nothing to confirm" isn't said.
  reading?: boolean;
  setupMode: boolean;
  headingLevel?: 2 | 3;
}) {
  const [result, run, pending] = useActionState(confirm, {});
  const id = useId();
  // The row being corrected, and what the last save said: it stays when the form closes.
  const [editing, setEditing] = useState<number | null>(null);
  const [saved, setSaved] = useState<string | undefined>(undefined);
  const editedRef = useRef<(done: string) => void>(() => {});
  editedRef.current = (done) => {
    setEditing(null);
    setSaved(done);
  };
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const flagged = table?.rows.filter((r) => r.doubt).length ?? 0;
  if (state === "none" || !table) {
    const unread = table?.gap?.kind === "unread";
    return (
      <div className="price-table" id="price-table">
        <Heading className="h4">Price table {unread && <Badge tone="warning">Prices not read</Badge>}</Heading>
        <p className={unread ? undefined : "muted"}>
          {note}
          {!unread && !reading && " Nothing to confirm, and sign-off doesn't wait for it."}
        </p>
      </div>
    );
  }
  return (
    <div className="price-table" id="price-table">
      <Heading className="h4">
        Price table{" "}
        {state === "confirmed" ? (
          <Badge tone="good">Confirmed</Badge>
        ) : state === "changed" ? (
          <Badge tone="warning">Changed since confirmed</Badge>
        ) : (
          <Badge tone="warning">Not confirmed</Badge>
        )}
      </Heading>
      <p className="help">
        {state === "confirmed" && confirmation
          ? `Confirmed against the pricing page by ${confirmation.by}, ${when(confirmation.at)}${confirmation.edited?.length ? ` (corrected by hand: ${confirmation.edited.join(", ")})` : ""}. Every price answer, in the chat and here, is checked against it.`
          : state === "changed" && confirmation
            ? `The pricing page was read again and differs from what ${confirmation.by} confirmed${table.changes?.length ? `: ${table.changes.join("; ")}` : ""}. Open the page and check these rows. ${UNCONFIRMED_CHAT}`
            : `Read from the pricing page. Open it, check each row once, and confirm: every price answer, in the chat and here, is then checked against it. ${UNCONFIRMED_CHAT}`}
      </p>
      <p>
        {table.pages.map((url) => (
          <a key={url} href={url} target="_blank" rel="noreferrer" className="button secondary">
            Open {path(url)}
          </a>
        ))}
      </p>
      <div className="table-wrap">
        {/* A phone's stylesheet stacks the rows, each cell labelled by data-label. */}
        <table>
          <thead>
            <tr>
              <th scope="col">Plan</th>
              <th scope="col">Price</th>
              <th scope="col">Per</th>
              <th scope="col">Read from</th>
              <th scope="col">
                <span className="sr-only">Correct</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, i) => (
              <Fragment key={`${row.plan}-${row.amount}-${row.period ?? ""}-${row.url}`}>
                <tr>
                  <th scope="row">
                    {row.plan}
                    {row.addOn && (
                      <>
                        {" "}
                        <Badge tone="neutral">Add-on</Badge>
                      </>
                    )}
                    {row.doubt && (
                      <span className="help" style={{ display: "block", fontWeight: "normal" }}>
                        <Badge tone="warning">Check this row</Badge> {row.doubt} Correct it, or save it as it is if it's right.
                      </span>
                    )}
                    {!row.doubt && !row.addOn && planNameDoubt(row.plan, titles[row.url]) && (
                      <span className="help" style={{ display: "block", fontWeight: "normal" }}>
                        <Badge tone="warning">This name may not be a plan</Badge> {planNameDoubt(row.plan, titles[row.url])}
                      </span>
                    )}
                  </th>
                  <td data-label="Price">
                    {row.amount}
                    {shownQualifiers(row).length ? <span className="muted price-note">{shownQualifiers(row).join(", ")}</span> : null}
                  </td>
                  <td data-label="Per">
                    {rowTerms(row, { perMonth: "monthly", perYear: "yearly" }) || (row.period === "once" ? "once" : "")}
                  </td>
                  <td data-label="Read from">
                    <span className="muted">{row.line}</span>
                  </td>
                  <td>
                    {edit[i] && remove[i] && (
                      <button
                        type="button"
                        className="button secondary"
                        aria-label={`Correct ${row.plan} ${row.amount}`}
                        aria-expanded={editing === i}
                        onClick={() => {
                          setSaved(undefined);
                          setEditing(editing === i ? null : i);
                        }}
                      >
                        Correct
                      </button>
                    )}
                  </td>
                </tr>
                {/* The form opens at its row (round 7: under the whole table, away from what it corrects). */}
                {editing === i && edit[i] && remove[i] && (
                  <tr className="row-edit-row">
                    <td colSpan={5}>
                      <RowEdit
                        action={edit[i]}
                        remove={remove[i]}
                        setupMode={setupMode}
                        row={row}
                        onSaved={(done) => editedRef.current(done)}
                        onClose={() => setEditing(null)}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {table.unplaced && table.unplaced.length > 0 && (
        <p className="notice" data-tone="warning" role="note">
          <Badge tone="warning">Check these figures</Badge> The pricing page states{" "}
          {[...new Set(table.unplaced.map((f) => f.figure))].join(", ")}, and no row has them, as the page gives no plan's name beside them.
          Add a row for each one that's a plan's price.
        </p>
      )}
      {saved && <Result state={{ done: saved }} />}
      {add && <RowAdd action={add} setupMode={setupMode} onSaved={(done) => editedRef.current(done)} />}
      {state !== "confirmed" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            startTransition(() => run(form));
          }}
        >
          {setupMode && <NameField id={`${id}-confirm-name`} />}
          {flagged > 0 && (
            <p className="help">
              {flagged === 1 ? "1 row is flagged" : `${flagged} rows are flagged`}: correct {flagged === 1 ? "it" : "them"}, or confirm{" "}
              {flagged === 1 ? "it" : "them"} as read, with your name on that.
            </p>
          )}
          <button type="submit" className="button" disabled={pending}>
            {pending
              ? "Confirming, and asking the price questions again…"
              : flagged > 0
                ? `Confirm, with ${flagged === 1 ? "the flagged row" : `the ${flagged} flagged rows`} as read`
                : "This matches the pricing page"}
          </button>
        </form>
      )}
      <Result state={result} />
      {state === "confirmed" && confirmation?.reasked && (
        <div className="price-reasked">
          <p className="label">
            {confirmation.reasked.questions.length
              ? `What visitors get now, asked again ${when(confirmation.reasked.at)}`
              : `The price questions couldn't be asked again: ${confirmation.reasked.note ?? "no answer came back"}. Run validation when it clears.`}
          </p>
          <ul className="plain">
            {confirmation.reasked.questions.map((q) => (
              <li key={q.question}>
                <strong>{q.question}</strong>{" "}
                {q.replaced === "link" ? (
                  <Badge tone="warning">Only the link to the pricing page</Badge>
                ) : q.replaced === "rows" ? (
                  <Badge tone="warning">The table's rows replaced the reply</Badge>
                ) : null}{" "}
                {q.held && <Badge tone="warning">Held: see Validate</Badge>}
                <span className="price-reask-answer">{q.answer}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
