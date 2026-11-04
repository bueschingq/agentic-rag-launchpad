// Review's "Client's name" line: what the chat actually says, not the customer record. It reads
// the saved prompt, every visitor-facing string of the widget in every language it serves, and
// the lead email. Done only when the name visitors see is in the prompt, the internal customer
// name (and any name the client went by before) is nowhere, unless it's the same name, and the
// prompt has no line that invites answers about how the chat works. Pure, so it runs under
// node:test; the caller passes the validation leak check's phrases.

import { type Language, languageName, type WidgetSettings } from "@launchpad/theme";
import {
  type LeakPhrase,
  matchesLeak,
  namesPattern,
  type PromptUpdate,
  promptSentences,
  renameClient,
  templateOf,
  updatedPrompt,
} from "./prompt-templates.ts";
import { LEAK_PHRASES } from "./validation-rules.ts";

export interface VisitorString {
  // In words, for the review line: "the welcome message (German)".
  where: string;
  text: string;
}

// Everything the partner wrote that visitors read in the widget, in each served language. The
// widget's own default text never names the client, so it isn't listed.
export function visitorStrings(s: WidgetSettings): VisitorString[] {
  const out: VisitorString[] = [];
  const add = (where: string, text: string | undefined, language?: Language) => {
    if (text?.trim()) out.push({ where: language ? `${where} (${languageName(language)})` : where, text });
  };
  add("the chat name", s.nickname);
  add("the welcome message", s.welcome);
  for (const q of s.starters ?? []) add("a starter question", q);
  add("the input's placeholder", s.placeholder);
  add("the AI disclosure line", s.disclosure);
  add("the offline message", s.offlineMessage);
  for (const text of Object.values(s.copy ?? {})) add("the widget's wording", text);
  add("the handoff message", s.handoff?.message);
  for (const c of s.handoff?.contacts ?? []) add("a handoff link", c.label);
  for (const c of s.ctas ?? []) add("a button", c.label);
  add("the contact form's intro", s.lead?.intro);
  add("the contact form's consent text", s.lead?.consentText);
  for (const [language, t] of Object.entries(s.translations ?? {}) as [Language, NonNullable<WidgetSettings["translations"]>[Language]][]) {
    if (!t) continue;
    add("the chat name", t.nickname, language);
    add("the welcome message", t.welcome, language);
    for (const q of t.starters ?? []) add("a starter question", q, language);
    add("the input's placeholder", t.placeholder, language);
    add("the AI disclosure line", t.disclosure, language);
    add("the offline message", t.offlineMessage, language);
    for (const text of Object.values(t.copy ?? {})) add("the widget's wording", text, language);
    add("the handoff message", t.handoffMessage, language);
    for (const c of t.handoffContacts ?? []) add("a handoff link", c.label, language);
    for (const c of t.ctas ?? []) add("a button", c.label, language);
    add("the contact form's intro", t.leadIntro, language);
    add("the contact form's consent text", t.leadConsent, language);
  }
  return out;
}

export interface ClientNameFacts {
  // The partner's own name for the customer.
  internal: string;
  // "Name visitors see"; null for a customer saved before it was required.
  visible: string | null;
  // Names the client went by in the chat before ("Name visitors see" before a change).
  previous?: readonly string[];
  // The saved prompt (the partner's text); with `served`, the prompt the Knowledge Box actually
  // answers with when it was changed outside the console.
  prompt: string;
  served?: string;
  strings: readonly VisitorString[];
  // The lead email's subject, as the client's team receives it.
  leadEmail: string;
  leakPhrases: readonly LeakPhrase[];
}

export type ClientNameProblem =
  | { kind: "no-name" }
  | { kind: "no-prompt" }
  | { kind: "missing"; served: boolean }
  | { kind: "other-name"; name: string; where: string; line: string }
  | { kind: "leak"; line: string };

const quote = (line: string, max = 140) => {
  const s = line.trim().replace(/\s+/g, " ");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

// The client's other names that are a problem where visitors read them: the internal one and
// earlier visible ones, except a short form the visible name contains ("Crayola" when visitors
// see "Crayola Company"), which still names the client rightly.
export function otherNames(visible: string, names: readonly string[]): string[] {
  return names.filter((n) => {
    const name = n.trim();
    if (!name || name.toLowerCase() === visible.trim().toLowerCase()) return false;
    return !namesPattern([name])!.test(visible);
  });
}

// The first other name found in `text`, ignoring where it's only part of the visible name
// ("Crayola" inside "Crayola Company").
function otherName(text: string, visible: string | null, others: readonly string[]): string | undefined {
  const absent = others.filter((n) => n.trim() && n.trim().toLowerCase() !== visible?.trim().toLowerCase());
  if (!absent.length) return undefined;
  const pattern = namesPattern([...(visible ? [visible] : []), ...absent])!;
  const keep = visible?.trim().toLowerCase();
  for (const m of text.matchAll(pattern)) {
    if (m[0].toLowerCase() !== keep) return absent.find((n) => n.trim().toLowerCase() === m[0].toLowerCase()) ?? m[0];
  }
  return undefined;
}

const sentences = (text: string) => text.split("\n").flatMap(promptSentences);

// In order of what to fix first: the prompt calling the client something else (quoted), the
// prompt not naming the client, a line inviting leaks, then the widget and the lead email.
export function clientNameProblems(f: ClientNameFacts): ClientNameProblem[] {
  if (!f.visible?.trim()) return [{ kind: "no-name" }];
  const visible = f.visible;
  const others = otherNames(visible, [f.internal, ...(f.previous ?? [])]);
  const named = (where: string, text: string): ClientNameProblem[] => {
    const name = otherName(text, visible, others);
    if (!name) return [];
    const line = sentences(text).find((sentence) => otherName(sentence, visible, [name])) ?? text;
    return [{ kind: "other-name", name, where, line }];
  };
  const prompts = [
    { where: "the saved prompt", text: f.prompt },
    ...(f.served !== undefined ? [{ where: "the prompt the Knowledge Box answers with", text: f.served }] : []),
  ].filter((p) => p.text.trim());
  const problems: ClientNameProblem[] = prompts.flatMap((p) => named(p.where, p.text));
  if (!f.prompt.trim()) problems.push({ kind: "no-prompt" });
  else if (!namesPattern([visible])!.test(f.served ?? f.prompt)) problems.push({ kind: "missing", served: f.served !== undefined });
  // The console's own template lines are written not to leak, whatever a phrase list says about them.
  for (const { text } of prompts) {
    const line = sentences(text).find((sentence) => !templateOf(sentence) && matchesLeak(sentence, f.leakPhrases));
    if (line && !problems.some((p) => p.kind === "leak" && p.line === line)) problems.push({ kind: "leak", line });
  }
  problems.push(...f.strings.flatMap((s) => named(s.where, s.text)), ...named("the lead email", f.leadEmail));
  return problems;
}

// The review line's detail for the first problem, quoting the line: "The saved prompt still calls
// the client 'Sitefinity Demo Co (review)': …".
export function clientNameDetail(problems: readonly ClientNameProblem[], f: Pick<ClientNameFacts, "internal" | "visible">): string {
  const more = problems.length > 1 ? ` (${problems.length - 1} more to fix)` : "";
  const p = problems[0];
  if (!p) {
    const internal = f.internal.trim().toLowerCase() !== f.visible?.trim().toLowerCase();
    return `The saved prompt calls the client "${f.visible}"${internal ? `, and "${f.internal}" isn't in it, the widget's text in any language or the lead email` : ""}. No line in it invites answers about how the chat works.`;
  }
  switch (p.kind) {
    case "no-name":
      return `Name visitors see isn't set, so nothing can check what the chat calls the client. Set it on the customer (it can be the same as "${f.internal}").`;
    case "no-prompt":
      return `Check this: the chat answers with the Knowledge Box's own prompt, which the console can't read. Update the prompt so it says "${f.visible}".${more}`;
    case "missing":
      return `Check this: ${p.served ? "the prompt the Knowledge Box answers with (changed outside the console)" : "the saved prompt"} never names the client "${f.visible}".${more}`;
    case "other-name":
      return `Check this: ${p.where} still calls the client "${p.name}": "${quote(p.line)}"${more}`;
    case "leak":
      return `Check this: the saved prompt has a line that invites answers about how the chat works: "${quote(p.line)}"${more}`;
  }
}

// "Update the prompt": the current template with the name visitors see, keeping the partner's own
// lines with the client's other names corrected. undefined until "Name visitors see" is set.
export function promptUpdate(
  d: { systemPrompt: string; siteUrl: string },
  names: { internal: string; visible: string | null; previous?: readonly string[] },
): PromptUpdate | undefined {
  const client = names.visible?.trim();
  if (!client) return undefined;
  return updatedPrompt(d.systemPrompt, {
    client,
    siteUrl: d.siteUrl,
    otherNames: otherNames(client, [names.internal, ...(names.previous ?? [])]),
    leakPhrases: LEAK_PHRASES,
  });
}

// The widget's text with the client's other names corrected, for "Update all" after a name
// change; undefined when nothing in it changes. Starter questions are left as they are: they're
// visitors' questions, asked in validation as written, so a person rewords them (Review lists any
// that still use another name).
export function renamedWidgetText(s: WidgetSettings, client: string, others: readonly string[]): WidgetSettings | undefined {
  const rename = (text: string | undefined) => (text === undefined ? undefined : renameClient(text, client, others));
  const out: WidgetSettings = {
    ...s,
    nickname: rename(s.nickname),
    welcome: rename(s.welcome),
    placeholder: rename(s.placeholder),
    disclosure: rename(s.disclosure),
    offlineMessage: rename(s.offlineMessage),
    ...(s.copy && { copy: Object.fromEntries(Object.entries(s.copy).map(([k, v]) => [k, rename(v)])) }),
    ...(s.handoff && {
      handoff: {
        ...s.handoff,
        message: rename(s.handoff.message),
        contacts: s.handoff.contacts.map((c) => ({ ...c, label: rename(c.label) })),
      },
    }),
    ...(s.ctas && { ctas: s.ctas.map((c) => ({ ...c, label: rename(c.label)! })) }),
    ...(s.lead && { lead: { ...s.lead, intro: rename(s.lead.intro), consentText: rename(s.lead.consentText) } }),
    ...(s.translations && {
      translations: Object.fromEntries(
        Object.entries(s.translations).map(([language, t]) => [
          language,
          t && {
            ...t,
            nickname: rename(t.nickname),
            welcome: rename(t.welcome),
            placeholder: rename(t.placeholder),
            disclosure: rename(t.disclosure),
            offlineMessage: rename(t.offlineMessage),
            handoffMessage: rename(t.handoffMessage),
            ...(t.copy && { copy: Object.fromEntries(Object.entries(t.copy).map(([k, v]) => [k, rename(v)])) }),
            ctas: t.ctas?.map((c) => ({ ...c, label: rename(c.label) })),
            handoffContacts: t.handoffContacts?.map((c) => ({ ...c, label: rename(c.label) })),
            leadIntro: rename(t.leadIntro),
            leadConsent: rename(t.leadConsent),
          },
        ]),
      ),
    }),
  };
  // JSON drops the keys left undefined, so an unchanged widget compares equal.
  return JSON.stringify(out) === JSON.stringify(s) ? undefined : (JSON.parse(JSON.stringify(out)) as WidgetSettings);
}
