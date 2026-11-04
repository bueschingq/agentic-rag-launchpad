# Answer quality: plan

**Status:** proposed on 2026-10-31, after the fifth persona review. Not built.

## Why this plan exists

For three review rounds, the blockers have been chat answers, and each cycle patched the symptom it was shown:

- **Round 3:** the bot called correct English price answers "Italian".
- **Round 4:** "we don't know, contact us" replies counted as answered, and price questions went unanswered on large sites.
- **Round 5:**
  - "Our website does not list prices" on chef.io, whose pricing page lists $59 and $189;
  - an upcoming webinar called "passed";
  - "The information we have does not provide…" counted as answered;
  - correct, cited price answers hidden because of a relevance-score cutoff.

The answers themselves come from Agentic RAG. What breaks is everything around them:

1. **How the product judges a reply.** A list of "we don't know" phrases, a figure check, and a score cutoff calibrated on one Knowledge Box. Nothing checks the reply against what the site says, so every new wording is a new hole.
2. **What retrieval gets to read.** Every question searches every page the same way. A price question competes with blog posts and product pages, and a "next webinar" question matches on-demand webinars rather than the page announcing the upcoming one.
3. **Facts the model can't interpret.** "Thursday, November 5" has no year, and on 31 October the model guesses the date has passed.

The round-5 proposal (`review-kit/round-5/proposal.md`) reaches the same root cause from the reviews alone. This plan adds what the reviews couldn't: what Agentic RAG itself offers, tested on the reviewers' real Knowledge Boxes.

## Tested before planning

On 2026-10-31, read-only, against the reviewers' round-5 Knowledge Boxes. Questions were asked as partner tests, so nothing counts as client traffic. Script: `review-kit/round-5/answer-quality-spike/spike-aq.ts`.

### A model judge, through Agentic RAG's own predict API

One call to `/predict/chat` with the account key the console already holds. The judge is told: "Judge the reply only against the site's text. yes / partly / no / contradicts."

| Case                                                                                                      | Expected    | Judge said                                        | Time  |
| --------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------- | ----- |
| crayola.com: "The information we have does not provide specific cleaning steps…"                          | no          | **no**                                            | 1.9 s |
| chef.io: "Our website does not list specific subscription prices" (pricing page lists $59 / $189)         | contradicts | **contradicts** ("lists prices from $59 to $189") | 0.9 s |
| whatsupgold.com: "No future webinar date is listed" (page: "Upcoming Live Webinar: Thursday, November 5") | contradicts | **contradicts**                                   | 1.3 s |
| kemptechnologies.com: the correct LoadMaster prices (the answer hidden by the score cutoff)               | yes         | **yes**                                           | 1.0 s |
| telerik.com: "DevCraft Complete costs $1,299 per developer, per year."                                    | yes         | **yes**                                           | 1.0 s |
| whatsupgold.com, German: the partial 300-device answer, "ab 1.229 $… Angebot"                             | yes         | **yes**                                           | 1.8 s |
| "Do you sell bicycles?" → the no-answer sentence                                                          | no          | **no**                                            | 0.8 s |

All 7 right, including the four blockers. There's nothing to set up.

### Routing a question to its intent's pages (chef.io)

The saved configuration was compared with the same configuration restricted to the pricing pages.

| Question                        | Saved config                                       | Routed to the pricing pages                                                                              |
| ------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| "How much does Chef cost?"      | "Our website does not list specific price amounts" | "Chef Business is listed at **$59 per node, per year**…"                                                 |
| "What does Chef Business cost?" | No answer (`no_context`)                           | "Chef Business costs **$59 per node, per year**. For a customized quote, visit our Pricing & Plans page" |

Routed answers had low relevance scores (0.03–0.05, one at 0.005). Today's 0.02 cutoff would hide some of them. So the score must stop deciding on its own.

### Event dates without a year (whatsupgold.com)

"When is the next WhatsUp Gold webinar?":

|                                                               | Answer                                                                                              |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Saved config                                                  | "We do not list a future WhatsUp Gold webinar date" (the upcoming-webinar page was never retrieved) |
| Routed to pages announcing an upcoming event                  | "The listed webinar was on Thursday, November 5… It has already passed"                             |
| Routed, with the date resolved ("Thursday, November 5, 2026") | "Our next webinar is 'Beyond the Firewall…' on **Thursday, November 5, 2026, at 11:00 AM**"         |

Both are needed: the right page, and a date the model can read.

## The options, judged on one rule: it sets itself up, or it's trivial to set up

| Approach                                                                                                                                   | What it fixes                                                                                                  | Setup                                                                                                                                                                                                                                                                                                 | Cost and speed                                                                                    | Verdict                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Model judge** (`/predict/chat`) in validation, the starter picker and the nightly report roll-up                                         | Reworded non-answers, false "missing" or "over" claims, correct answers hidden by the score                    | None: the console's account key                                                                                                                                                                                                                                                                       | About 1–2 s per answer judged; only at validation, picking and roll-up, never per visitor message | **Build now**                                                                                                                                                   |
| **Several search configurations with intent routing**                                                                                      | Price, contact, support and event questions answered from their pages (the chef.io and webinar cases)          | **Self-setup:** the console creates the configurations per deployment (default, price, contact, support, events) and keeps them current. The widget picks one from the question's intent words (already written for seven languages) and falls back to the default when the routed ask finds nothing. | One ask; a second only on fallback                                                                | **Build now**                                                                                                                                                   |
| **Page-type labels written by the worker** as it sends each page (`usermetadata.classifications`: pricing, contact, support, events, faq…) | What routing filters on; also questions-by-page-type in the report                                             | **Self-setup:** derived from key pages, titles and event detection the sync already does                                                                                                                                                                                                              | Free                                                                                              | **Build now**                                                                                                                                                   |
| **Resolving dates at ingest:** "Thursday, November 5" → "Thursday, November 5, 2026", by matching the weekday, near the page's own date    | Events called over or missing                                                                                  | **Self-setup**, in the worker                                                                                                                                                                                                                                                                         | Free                                                                                              | **Build now**                                                                                                                                                   |
| **Labeler agent** (DA)                                                                                                                     | Labels pages whose address and title don't reveal their type                                                   | Self-setup possible: the console creates one task with a fixed page-type label set at provisioning                                                                                                                                                                                                    | One model call per page at processing, and it adds to the first sync                              | **Pilot.** Deterministic labels cover the cases seen so far; measure what the Labeler adds on held-out sites first                                              |
| **Synthetic questions agent** (DA)                                                                                                         | Natural phrasing that misses the page's own words ("What are your prices?", "slime" when the site says "goo")  | Self-setup possible: one task at provisioning, with a site-agnostic prompt ("questions a visitor to this website would type; never restate the heading")                                                                                                                                              | Several model calls per page; more indexed text; slower first sync                                | **Pilot**, measured on the generic-question set below. Ship on by default only if it helps and the first answerable page stays within about 1 minute of Create. |
| **Generator agent** (`ask`): a one-line "what this page answers" per page                                                                  | The fix panel's "pages that may answer this" search (the goo/slime case), and better retrieval for vague pages | Self-setup possible                                                                                                                                                                                                                                                                                   | One model call per page                                                                           | **Pilot alongside synthetic questions.** If synthetic questions fix the panel's misses, this isn't needed.                                                      |
| **Knowledge graph** (`llm-graph`)                                                                                                          | Catalog questions across products and tiers ("Kendo UI vs DevCraft", tiered prices)                            | Hard to make automatic: it needs an entity and relation schema with few-shot examples per kind of site, and its output needs filtering                                                                                                                                                                | Model calls per page; graph retrieval is the least proven path here                               | **Later**, for multi-product catalog sites, once routing has been measured                                                                                      |

## What to build in cycle 5

This combines with the round-5 proposal (its items in brackets).

1. **The judge** [proposal 1, 2, 5]. Validation and the starter picker ask the judge about every answer, giving it the cited passages, plus the matching key pages' text for price, contact, support and event questions.
   - "no" and "contradicts" hold the answer, with the judge's reason and the page's own figures or dates.
   - "partly" is Check this.
   - The judge can only make a result stricter. The phrase lists stay as a fast first pass.
   - The nightly report roll-up judges logged answers the same way, so content gaps are real.
2. **Intent routing with self-made search configurations** [proposal 3].
   - The console writes `<config>-price`, `-contact`, `-support` and `-events` beside the default. Each filters on the worker's page-type labels and carries a short prompt for its intent: "state each price and its unit exactly as written", or "events: today's date, upcoming first".
   - The widget routes by intent, and falls back to the default configuration when a routed ask finds nothing.
   - Validation asks each intent question in the visitor's generic wording and with the product's name.
3. **The score stops hiding answers** [proposal 1]. A cited reply with concrete content (a figure, a step, a link, a contact) is shown, whatever its relevance score. The score only demotes uncited replies.
4. **Dates resolved at ingest** [proposal 4]. The worker writes the year next to year-less dates, by weekday and the page's own date. The extractor version goes up, so pages are read again.
5. **Rollout per deployment** [proposal 6, 7]. Prompt, routing and verdict changes reach a signed-off deployment only after its own re-validation, with the judge. Anything that gets worse is held, with one alert. Retire the hourly push.

## The DA agent pilot, in the same cycle

1. **Before any build:** free two Knowledge Box slots, by deleting superseded round-4 reviewer KBs. The account has 29 of 30.
2. On two sites the team hasn't tuned against, chosen by someone outside the developers: one large single-language site and one multilingual site. Onboard each twice: once as built, once with the synthetic questions and generator agents created automatically at provisioning.
3. Ask the same **held-out question set** of both: the generic visitor wording for price, contact, support and events; vocabulary mismatches; and questions about the site's top pages.
4. **Set citation explicitly.** Whether the generated text (the synthetic questions and the `da-launchpad_answers` field) can be cited is a search configuration option. The console sets it in the deployment's saved configurations rather than leaving it to the default. The pilot runs the "agents on" deployment both ways:
   - generated text helps retrieval but isn't cited, so answers quote the page's own words;
   - generated text can also be cited.

   It records which reads better to a visitor and which the judge scores higher.
5. **Ship the agents on by default only if** the share answered and judged "yes" rises by at least 10 points, and the first answerable page stays within about 2 minutes of Create. Otherwise leave them off, and record why.

## Pilot result (2026-10-31)

Ghost.org, a site the team hadn't tuned on: 1,585 pages, English, with pricing, contact and a help centre. It was onboarded twice with defaults, and 26 held-out questions were asked 3 times each. Report: `review-kit/round-6/pilot/report.md`.

|                                                     | Judged "answers" | Change                                                |
| --------------------------------------------------- | ---------------- | ----------------------------------------------------- |
| Agents off                                          | 83.3%            | —                                                     |
| Agents on, generated text citable (the API default) | 75.6%            | −7.7 points                                           |
| Agents on, generated text not citable               | 88.5%            | +5.1 points (mostly judge noise on identical answers) |
- **Below the 10-point bar,** so the agents stay **off by default**.
- **The first answerable page** came in 2 min 03 s with the agents, against 49 s without.
- **Retrieval didn't change** in what it returned.
- **Citing generated sentences made answers worse:** they quoted the generated text and drifted into talking about their sources.
- **When a partner turns the agents on,** every saved configuration must exclude generated fields: `filter_expression.field: {not: {prop: "generated", by: "data-augmentation"}}`, joined with "and" to any intent filter. There's no citations-only switch, so the filter also keeps generated text out of retrieval. Synthetic questions still apply.
- **The misses in both setups** were help pages outside the 200-page budget. Budget and selection matter more than augmentation here. That's the next lever to study.

## Acceptance for this plan

On held-out sites and on the reviewers' sites:
- **The judge** agrees with a person on at least 95% of a 100-answer labelled set. It makes no false "no" on the 50 short English price answers or on the multilingual quote answers.
- **Price, contact and support questions**, in generic visitor wording, are answered from their key pages on every site that has them. "What are your prices?" shows its cited prices, not the no-answer reply.
- **An upcoming event** printed without a year is named as upcoming, with its date and year.
- **Setup:** none of it adds a step for the partner. The only new thing they see is the judge's reason when an answer is held.
