// The account's Knowledge Box allowance where a partner decides on the next client: Settings,
// first-run setup on Fleet, and New deployment. An unknown limit is a warning, never plain text,
// because the first refusal would otherwise come mid-call.

import { saveKbLimit } from "@/app/settings/actions.ts";
import { capacityMessage, type KbAllowance } from "@/lib/capacity.ts";

// The notice: "Knowledge Boxes: 27 of 30 used, 3 left." Full is an alert, since Create is off.
export function CapacityNotice({ allowance, waiting = 0 }: { allowance: KbAllowance; waiting?: number }) {
  const { text, tone } = capacityMessage(allowance, waiting);
  return (
    <p className="notice" data-tone={tone === "good" ? undefined : tone} role={tone === "critical" ? "alert" : "note"}>
      {text}
    </p>
  );
}

// An admin enters the limit from the Progress order, when no PAT lets the console read it.
export function KbLimitForm({ allowance, next, invalid }: { allowance: KbAllowance; next?: "/"; invalid?: boolean }) {
  return (
    <form action={saveKbLimit} className="inline-form">
      {next && <input type="hidden" name="next" value={next} />}
      <label htmlFor="kbLimit">Account limit, from the Progress order</label>
      <input
        id="kbLimit"
        name="kbLimit"
        type="number"
        min={1}
        inputMode="numeric"
        defaultValue={allowance.source === "entered" ? allowance.limit : undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? "kbLimit-error" : undefined}
      />
      <button className="button secondary" type="submit">
        Save limit
      </button>
      {invalid && (
        <span id="kbLimit-error" className="field-error">
          Enter a whole number, or leave it empty to forget the limit.
        </span>
      )}
    </form>
  );
}
