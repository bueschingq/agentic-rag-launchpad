// Model text as the console shows it: validation, the picker, Review and the report render a reply
// exactly as the chat does (renderModelText in @launchpad/theme): no Markdown syntax on screen, and
// links only to the deployment's synced pages and call-to-action targets (modelTextLinks). With
// `note`, an answer whose formatting had to be repaired says so, so partners see the model's habit:
// a note, not a hold.

import { type LinkContext, renderModelText } from "@launchpad/theme";

export const REPAIRED_NOTE = "Formatting the chat couldn't show: rendered as plain text.";

export function ModelText({
  text,
  links,
  className,
  note = false,
}: {
  text: string;
  links?: LinkContext;
  className?: string;
  note?: boolean;
}) {
  const { html, repaired } = renderModelText(text, links);
  return (
    <>
      {/* Safe: renderModelText escapes every character of the model's text and writes only vetted hrefs. */}
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: the HTML is renderModelText's, escaped throughout */}
      <div className={className ?? "model-text"} dangerouslySetInnerHTML={{ __html: html }} />
      {note && repaired && <p className="help">{REPAIRED_NOTE}</p>}
    </>
  );
}
