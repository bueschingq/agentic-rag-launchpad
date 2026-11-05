// "Update the prompt", wherever it's offered (Review's Client's name line, Bring up to date): the
// saved prompt before and after, the partner's own lines kept, and what's left out and why.
// Saving sends it to the Knowledge Box, and the page it returns to checks it again.

import { PROMPT_TEMPLATES, type PromptUpdate } from "@/lib/prompt-templates.ts";

export function PromptUpdatePanel({
  before,
  update,
  save,
  keep,
  saveLabel = "Save the new prompt",
}: {
  before: string;
  update: PromptUpdate;
  save: (form: FormData) => Promise<void>;
  // Bring up to date only: go on with the current prompt, recorded.
  keep?: (form: FormData) => Promise<void>;
  // The save button's words: "Update the prompt" where the saved prompt lacks today's template lines.
  saveLabel?: string;
}) {
  const same = before.trim() === update.prompt.trim();
  const template = PROMPT_TEMPLATES.find((t) => t.key === update.template)?.label ?? "General";
  return (
    <div className="prompt-update">
      {same ? (
        // After Save the new prompt the page returns here: focus goes to this line, not <body> (round 6).
        // biome-ignore lint/a11y/noAutofocus: it says what Save the new prompt did
        <p className="notice" data-tone="good" role="status" tabIndex={-1} autoFocus>
          The saved prompt already is the current {template.toLowerCase()} template, with your own lines.
        </p>
      ) : (
        <>
          <div className="field-grid">
            <div>
              <h3 className="h4">Before: what the chat answers with now</h3>
              {before.trim() ? <pre className="prompt">{before}</pre> : <p className="muted">The Knowledge Box's own prompt (imported).</p>}
            </div>
            <div>
              <h3 className="h4">After: the current {template.toLowerCase()} template</h3>
              <pre className="prompt">{update.prompt}</pre>
            </div>
          </div>
          {update.kept.length > 0 && (
            <>
              <p className="help">Your own lines, kept at the end:</p>
              <ul>
                {update.kept.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </>
          )}
          {update.dropped.length > 0 && (
            <>
              <p className="help">Left out:</p>
              <ul>
                {update.dropped.map((d) => (
                  <li key={d.line}>
                    <q>{d.line}</q>: {d.why}.
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
      <div className="actions">
        {!same && (
          <form action={save}>
            <input type="hidden" name="before" value={before} />
            <button className="button" type="submit">
              {saveLabel}
            </button>
          </form>
        )}
        {keep && (
          <form action={keep}>
            <button className="button secondary" type="submit">
              {same ? "Go on" : "Keep the current prompt"}
            </button>
          </form>
        )}
      </div>
      {!same && (
        <p className="help">
          Saving sends it to the Knowledge Box: the chat answers with it from the next question, and the Client's name line checks it again.
        </p>
      )}
    </div>
  );
}
