// Today's date in the chatbot's saved prompt, so answers can tell past events from coming
// ones. The widget asks with the saved search configuration straight from the visitor's
// browser, so the date has to live there: the console adds it whenever it saves a prompt, and
// the worker brings it up to date every day. It's always the prompt's last paragraph.
//
// The events rule matches the events configuration's (apps/console/src/lib/prompt.ts): an event
// is over only if its full date, with the year, is before today. Round 5: "dated before today are
// over" let the model call a webinar five days away, "Thursday, November 5", passed.

const RULE_START = "Today's date is ";

const DAY = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

// Answering rules 5 (round 7): the tense follows the date, and "none upcoming" only when no date
// given is today or later (wartsila's "took place on 2–4 December 2026", bynder's "We will be at …
// on October 27, 2026", and "No upcoming events are dated on or after 2 November 2026" while the
// site listed some).
// Answering rules 7 (round 7, clopaydoor.com on 2 November: "Our next listed event is the AIA Austin
// Homes Tour, taking place October 24-25, 2026", from a blog post inviting visitors to it; and
// mvtec.com: "the title points to 26 November", from "HALCON 26.11"): an event before today isn't next
// or upcoming even when its page still invites to it, and a date comes from the page's date for it.
const EVENTS_RULE =
  "An event, webinar, offer or deadline is over only if its full date, with the year, is before today: one dated today or later is " +
  "next, upcoming or open, and a date written without a year is never called over. First compare each event's date with today's date: " +
  "a month that has ended is before today. An event dated before today is over, even if its page still invites to it and even if it is " +
  "the only one you have: never call it next, upcoming or taking place; say that it took place. Tell each one in " +
  "the tense its date gives: before today it took place, today or later it will take place. An event's date is the date its page gives " +
  "for it: a number in a name is a version (26.11, v5.2), not a date. Say that nothing is upcoming only if no " +
  "page you were given dates the kind of event asked about today or later; then say it in one sentence, without naming today's " +
  "date, and link our events page if you have it.";

// The wording saved from answering rules 5 to 6, kept by the daily refresh like the ones before.
const EVENTS_RULE_V5 =
  "An event, webinar, offer or deadline is over only if its full date, with the year, is before today: one dated today or later is " +
  "next, upcoming or open, and a date written without a year is never called over. Tell each one in the tense its date gives: before " +
  "today it took place, today or later it will take place; never list a past one as upcoming. Say that nothing is upcoming only if no " +
  "page you were given dates the kind of event asked about today or later; then say it in one sentence, without naming today's " +
  "date, and link our events page if you have it.";

// The wording saved from round 5 to answering rules 4, kept by the daily refresh like the one before.
const EVENTS_RULE_V4 =
  "An event, webinar, offer or deadline is over only if its full date, with the year, is before today: one dated today or later is " +
  "next, upcoming or open, and a date written without a year is never called over. If no date on or after today is given for what " +
  "the visitor asks about, say so in one sentence and link our events page if you have it.";

// The wording saved before round 5. The daily refresh changes only the date (jobs/prompt-date.ts),
// so a prompt saved with it keeps it until the prompt is saved again or new answering rules are
// applied after their re-check: nothing reaches a signed-off chat unchecked.
const EVENTS_RULE_BEFORE =
  "Events, webinars, offers and deadlines dated before today are over: never call them next, " +
  "upcoming or open. If no date after today is given for what the visitor asks about, say so in one sentence and link our events page if you have it.";

export const todayRule = (today: Date, rule: string = EVENTS_RULE): string => `${RULE_START}${DAY.format(today)}. ${rule}`;

// The prompt's date paragraph, if it has one.
function todayParagraph(system: string): string | undefined {
  const at = system.lastIndexOf(`\n\n${RULE_START}`);
  if (at >= 0 && !system.slice(at + 2).includes("\n\n")) return system.slice(at + 2);
  return system.startsWith(RULE_START) && !system.includes("\n\n") ? system : undefined;
}

// The prompt without its date paragraph (to compare two prompts saved on different days).
export function withoutToday(system: string): string {
  const paragraph = todayParagraph(system);
  if (paragraph === undefined) return system;
  return system.slice(0, system.length - paragraph.length).replace(/\n\n$/, "");
}

// The prompt with today's date: a new date paragraph keeps the events rule it was saved with.
export const withToday = (system: string, today: Date): string => {
  const paragraph = todayParagraph(system);
  const kept = paragraph?.includes(EVENTS_RULE_BEFORE)
    ? EVENTS_RULE_BEFORE
    : paragraph?.includes(EVENTS_RULE_V4)
      ? EVENTS_RULE_V4
      : paragraph?.includes(EVENTS_RULE_V5)
        ? EVENTS_RULE_V5
        : EVENTS_RULE;
  const rest = withoutToday(system).trimEnd();
  return rest ? `${rest}\n\n${todayRule(today, kept)}` : todayRule(today, kept);
};
