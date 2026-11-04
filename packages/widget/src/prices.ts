// Price answers checked against the deployment's confirmed price table, live (round 6, item 1).
// For a price question the widget holds the streamed text until the answer is complete, then
// runs the shared claim check (checkPriceClaims in @launchpad/theme), the same as validation, the
// picker and the overnight re-run. A reply that contradicts the table is never shown as written:
// the visitor gets the table's rows for the plans asked about (every plan when the question names
// none), citing the pricing page, with the pricing or quote button. Pure, so it's tested in Node.

import { checkPriceClaims, type PriceTable, type Source } from "@launchpad/theme";

// Shared with validation, so it shows what the chat shows (build 8).
export { priceReplacement, rowLine } from "@launchpad/theme";

// A reply denying a price the pricing page states ("Our Pricing page doesn't list the price for
// the Audio + Video plan", "It does not state an annual price"), about what was asked: no answer,
// with the handoff card (round 7, item 4). Against the confirmed table, else the pricing page's
// own pairings (config.pricingFacts).
export function deniesListedPrice(
  question: string,
  answer: string,
  table: PriceTable | undefined,
  cited: readonly Source[],
  language?: string,
): boolean {
  if (!table || !answer) return false;
  return checkPriceClaims(
    answer,
    table,
    cited.map((s) => s.href),
    language,
    { question },
  ).contradictions.some((c) => c.reason === "unlisted");
}
