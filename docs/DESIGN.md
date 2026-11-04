# Agentic RAG Launchpad — v1 design

_Working name. An open-source, self-hosted console that lets a Sitefinity partner agency run Progress® Agentic RAG chat agents for many customers, the way a managed service provider would._

Status: draft for review · 2026-10-26 · M0 spike results folded in 2026-10-27 (§4a)

---

## 1. Why this exists

ai12z sells into the same Sitefinity accounts that Progress Agentic RAG now serves natively. Its pitch to agencies is simple: paste a site URL, get a branded agent, embed it, and manage all clients from one portal. Agentic RAG already has most of the building blocks: a Sitefinity 15.4+ connector, an AI Assistant widget, and a full account/zone API. What it lacks is a **partner-facing workflow**. Today a partner has to:

1. Create a KB in the dashboard, pick models, and mint a Writer key.
2. Write a prompt and search configuration by hand.
3. Copy the endpoint, UID and key into Sitefinity's _Administration › Settings › Agentic RAG connection_ (the path the console's Content panel gives).
4. Accept a widget that comes in four styles and doesn't blend into the customer's site.
5. Repeat all of this per client, with no cross-client view of usage, cost or quality.

**Target:** site URL in → themed, working chat on the customer's staging site in **under 30 minutes and under 10 clicks**, with every client visible in one dashboard.

**Proposed promise wording (after the sixth persona review; awaiting the product owner, not adopted):** "Under 30 minutes for one site in one language, with staging access; about 6–8 minutes for each extra language." This is the team's proposal (`review-kit/round-6/proposal.md` §5). No person has timed an onboarding yet. The product owner decides whether a person-timed onboarding runs, and with whom, and until then the promise stays as it is above.

## 2. Decisions taken

| Topic            | Decision                                                                                                                                                                                              |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stack            | Next.js (App Router) + TypeScript in an npm-workspaces monorepo, one Docker image per service. Dependencies are kept minimal (see §3)                                                                 |
| Hosting          | Self-hosted per partner. Each instance holds that partner's enterprise-account credentials; tenants are the partner's customers                                                                       |
| Commercial model | Assumes a partner enterprise contract: one Agentic RAG account per partner, one KB per customer site/deployment                                                                                       |
| v1 scope         | Provisioning wizard · fleet & cost dashboard · customer access · embeddable widget for any site                                                                                                       |
| Widget auth      | Private KBs. The console mints a reader-scoped ephemeral token per chat session (`POST /ephemeral_token`, ~15 min TTL). KB `allowed_origins` is locked to the customer's domains. Both verified in M0 |
| Widget styling   | Our own themeable chat web component, auto-themed by sniffing the customer site's CSS (replaces the stock four-style widget)                                                                          |

## 3. Architecture

```mermaid
flowchart LR
  subgraph Partner-hosted (docker compose)
    C[console<br/>Next.js UI + API]
    W[worker<br/>pg-boss jobs]
    S[sniffer<br/>Playwright service]
    DB[(Postgres)]
    C --- DB
    W --- DB
    C -->|sniff URL| S
  end
  subgraph Progress Agentic RAG
    A[Account API<br/>accounts.progress.cloud]
    Z[Zone API<br/>KBs, keys, tokens, sync, activity]
    K[KB API<br/>/ask, /find, feedback]
  end
  subgraph Customer site
    SF[Sitefinity 15.4+ connector]
    WC["&lt;arag-chat&gt; web component"]
  end
  C --> A & Z
  W -->|usage, activity, REMi, sync status| A & Z
  SF -->|indexes content| K
  Z -->|sitemap sync| K
  WC -->|GET config + ephemeral token| C
  WC -->|/ask stream with token| K
```

### Repository layout

```
apps/console          Next.js app: partner UI, customer UI, internal API, public widget endpoints
apps/worker           pg-boss jobs: usage, cost and REMi rollups (later: sync health, budget alerts)
apps/sniffer          HTTP service wrapping Playwright for site detection and style scanning
packages/par-client   Hand-written, dependency-free client for the Account, Zone and KB APIs
packages/widget       <arag-chat> web component (no framework, shadow DOM, design tokens), bundled by esbuild
packages/theme        Theme tokens, sanitising, contrast repair, widget settings and the public config shape
packages/db           Drizzle schema, migrations, sealed key storage
```

### Dependency policy

Every dependency becomes supply-chain surface for each partner who self-hosts this, so the runtime set is kept small:
- **par-client, theme, widget:** no runtime dependencies.
- **Tests:** Node's built-in `node:test`.
- **Worker and sniffer:** run their TypeScript directly on Node 22.18+ with no build step.
- **Third-party packages, all pinned and reviewed:** Next.js and React (console), Drizzle and postgres.js (db), pg-boss (worker), Playwright (sniffer), esbuild (widget build only), Biome and TypeScript (dev only).

## 3a. Scaffold status (2026-10-27)

**Verified on a machine without npm access.** Public npm registries are blocked there, so this check covers the dependency-free code paths only:
- 100 unit tests pass: par-client, theme (including finishes and their contrast), key sealing, console origin rules, dashboard arithmetic and settings validation, worker dates, sniffer URL safety, detection and theme derivation, and widget session and sources.
- All 74 `.ts` files parse.
- The widget ran end to end in Chromium from source, with Node stripping the types (`spike/widget/server.ts`), against the M0 spike KB:
  - config load, then one session token for several questions
  - streamed answers with source links built from `show: ["origin"]`
  - follow-up questions via `chat_history`
  - a themed and a default look, and a full-screen layout at 375 px
  - Escape closing the panel with focus returning to the launcher
  - all four display modes and all three finishes, including the popup's backdrop, Escape and focus return, a page button opening the chat through `data-arag-chat-open`, and full-screen floating and popup layouts at 375 px

**Verified in CI** (GitHub Actions, Node 24, `npm ci` from the committed lockfile):
- Biome lint and format
- `tsc` typecheck across all seven workspaces
- the Next.js 16 build
- the widget bundle: 7.7 KB gzipped then (44.7 KB in the build of 2026-11-01, measured at each build), against a 40 KB budget (45 KB since 2026-10-31)
- Drizzle migration generation (`packages/db/migrations/0000_giant_sasquatch.sql`)
- the console on Postgres 17, in the `preview` job (`apps/console/scripts/preview.ts`):
  - the migration applies and the demo seed loads (`packages/db/src/seed-demo.ts`)
  - the standalone server serves every dashboard page, at 1280 px and 390 px, with no errors and no sideways scrolling on a phone
  - cost totals on the fleet and costs pages match the database, and the CSV export works
  - the seed's sync, provisioning and quality alerts show on the fleet page
  - a settings save reaches the database and the audit log
  - screenshots and a report are attached to every run as `console-preview`

**Not yet verified:**
- the worker's rollup jobs against real KBs (the preview uses seeded rollups)
- pg-boss scheduling
- the Playwright scan
- Docker images and Compose

## 4. Agentic RAG API surface we rely on

These are from the reference pages (`/docs/account-api`, `/docs/knowledgebox-zone-api`, `/docs/api`), then exercised against a v3enterprise account in M0 (§4a). **Credential** is the one that worked.

Hosts: Account API `https://accounts.progress.cloud/api/v1`. Zone and KB APIs `https://{zone}.dp.progress.cloud/api/v1`; `/ask` also answers on `{zone}.rag.progress.cloud`.

| Need                             | Endpoint                                                                                                                                                    | Credential                  | M0                                            |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | --------------------------------------------- |
| Resolve account from key         | `GET {zone}/api/authorizer/info` → `account_id`, `account_type`                                                                                             | NUA key                     | ✅                                            |
| Account limits (max KBs, quotas) | `GET /account/{id}` → `max_kbs`, `limits.usage.*`                                                                                                           | PAT only (NUA key → 403)    | ⏳ needs PAT                                  |
| Create / modify / delete KB      | `POST /account/{id}/kbs` (slug, title, `allowed_origins`, `search_configs`, …), `PATCH`/`DELETE /account/{id}/kb/{kb}`                                      | NUA key or PAT              | ✅ 1.7 s                                      |
| Per-KB API keys                  | `POST /account/{id}/kb/{kb}/service_accounts` (role) + `/service_account/{sa}/keys` (`expires`)                                                             | NUA key or PAT              | ✅                                            |
| Browser token                    | `POST /ephemeral_token` `{ttl}`, sent as `?eph-token=`                                                                                                      | reader key                  | ✅                                            |
| Saved prompt/RAG config          | `POST /kb/{kb}/search_configurations/{name}` `{kind:"ask", config}`; `/ask` takes `search_configuration`. Once it exists POST → 409 and `PATCH` replaces it | manager key                 | ✅ PATCH 2026-10-29                           |
| Ingest                           | `POST /kb/{kb}/resources` (text, link, file; `origin.url` for citations); same slug → 409, then `PATCH /slug/{slug}`                                        | writer key                  | ✅ text ~10–30 s; link 220–235 s (2026-10-30) |
| Server-side crawl                | `POST /kb/{kb}/external_connections` (`provider: "sitemap"`) + `/sync_configs` + `/sync_config/{id}/sync`, `/jobs`                                          | manager key or PAT          | ⏳ not run (§4a)                              |
| Usage per tenant                 | `GET /account/{id}/usage?knowledgebox={kb}&aggregation=day&from=…`                                                                                          | PAT only (NUA key → 403)    | ⏳ needs PAT                                  |
| Volume                           | `GET /kb/{kb}/activity/metrics` (search / ask / chat per hour)                                                                                              | manager key (NUA key → 403) | ✅ near real time                             |
| Question log                     | `POST /kb/{kb}/activity/ask/query` (NDJSON: question, answer, `nuclia_tokens`, `status`, `resources_count`, `client_type`, feedback)                        | manager key                 | ✅                                            |
| Partner-test tag                 | `X-NDB-CLIENT: dashboard` on `/ask` → logged with `client_type: "dashboard"` (`audit_metadata` isn't returned by the log)                                   | any                         | ✅ 2026-10-30                                 |
| Quality                          | `GET /kb/{kb}/remi/scores`, `POST /kb/{kb}/remi/query`                                                                                                      | manager key                 | ✅ scores within minutes                      |
| Customer KB access               | `PATCH /account/{id}/kb/{kb}/users`, `POST …/invite` (`SOWNER`, `SMEMBER`, `SCONTRIBUTOR`)                                                                  | NUA key or PAT              | not run                                       |
| Backups                          | `/account/{id}/backups`, `/restore`                                                                                                                         | —                           | not run                                       |

**What the console stores:**
- The partner's **NUA key** (`allow_kb_management`) for all provisioning.
- An optional **PAT** for account limits and per-KB usage.
- Three keys per KB: **reader** (mints browser tokens), **writer** (Sitefinity connector and ingestion), and **manager** (search configs and analytics).

## 4a. M0 spike results (2026-10-27)

Run from `spike/` against an enterprise account (`v3enterprise`, zone `aws-us-east-2-1`). Raw log: `spike/out/findings.md`.

**Provisioning**
- A NUA key with `allow_kb_management` does everything provisioning needs: create the KB with `allowed_origins`, create reader, writer and manager service accounts, and issue 30-day keys. The whole chain took about 3 s.
- The Account API rejects NUA keys ("Nuakeys are not valid in the global API"). Limits and per-KB usage still need a PAT.

**Answers**
- `/ask` streams NDJSON. Chunk types are `answer`, `retrieval`, `status`, `augmented_context`, `citations`, `metadata` and `consumption`.
- First answer text arrives in 0.9–1.8 s; in a real browser, about 2.8 s end to end including the token fetch.
- Reader keys get 403 on writes. Text resources reach PROCESSED in about 6 s.

**Browser tokens.** This changed the design.

|                                       | Temporal key `POST /service_account_temporal_key` | Ephemeral token `POST /ephemeral_token` |
| ------------------------------------- | ------------------------------------------------- | --------------------------------------- |
| Max TTL                               | 10 s                                              | 900, 3,600 and 86,400 s all accepted    |
| How sent                              | `X-NUCLIA-SERVICEACCOUNT` header                  | `?eph-token=` query only (header → 400) |
| Scope when minted from the reader key | reader                                            | reader (write → 403, `/find` → 200)     |
| Expired                               | 401                                               | 403                                     |
| Mint latency                          | 0.5–0.85 s                                        | ~0.07 s                                 |
- An in-flight stream is **not** cut off when its token expires. A request started at +9.3 s on a 10 s key finished at +12.7 s.
- **Decision:** the widget gets one ephemeral token per chat session (~15 min TTL) and refreshes it on 403. That avoids a mint round trip on every question.
- Because the token rides in the URL, keep TTLs short and never log full request URLs.

**Domain lock**
- `allowed_origins` drives CORS. An allowed origin gets preflight 200 with a matching `Access-Control-Allow-Origin`. Any other origin gets preflight 403, and Chromium blocks the request before an answer is generated (verified in a real browser).
- Progress's own dashboard origin is always allowed.
- Non-browser clients are **not** blocked; a server-side POST with a foreign `Origin` still gets 200. The lock stops other websites embedding the KB, not scripted abuse. Rate limiting on the token endpoint stays essential.
- The list must have at least one entry (an empty list → 422).
- Changes take **15–60 s** to apply. The wizard should poll a preflight from the customer domain before marking a deployment live.

**Analytics without a PAT**
- With the manager key:
  - activity metrics are near real time (per hour)
  - REMi scores (`answer_relevance` 1–5, `context_relevance`, `groundedness`) appear within minutes
  - the question log returns every question with its answer, `nuclia_tokens` (about 0.14–0.23 per answer here), model, timings and feedback
- So query volume, quality, content gaps and **query-side cost** can be computed per tenant from KB keys alone. Processing and storage cost still needs the PAT usage API.

**Sitefinity detection**
- `crayola.com` runs Sitefinity, but its `generator` meta tag is stripped. Detect from `data-sf-` attributes (43 on its homepage) and Sitefinity resource paths instead.
- The version isn't exposed. The wizard asks the partner for it, or defaults to the sitemap and embed path.

**Not yet verified**
1. **Sitemap sync:** Crayola's sitemap lists 5,438 pages, over the spike's 100-page cap, so no sync ran. Large Sitefinity sites are normal, so the wizard needs a page budget and URL include/exclude rules. We still need to learn whether `file_filter.glob_patterns` applies to sitemap URLs.
2. **Per-KB usage and account limits:** need a PAT.
3. **Customer invites:** not run.

## 5. Provisioning wizard

One page, three inputs: **customer**, **site URL**, **deployment name**. Everything else is detected or defaulted from a partner-level template.

**Landed 2026-10-29, first slice** (`apps/console/src/lib/provision.ts`):
- **New customer:** contacts (each with an optional KB role), billing details with no card or bank numbers, and a default language.
- **New deployment:** customer, site URL, extra domains, language, and the system prompt.
- **Steps run:** 3.1 (the KB, locked to the site), 3.2 (the partner's prompt plus a language rule), 3.3 (three 1-year keys), customer invites, then the embed snippet.
- **Resumable:** each step is logged, and a retry skips steps that already happened.
- **Verified against a real account:** KB, keys, prompt, retry, and the widget in Spanish and in `auto`.
- **Not yet** (in that slice): detection, sitemap sync, the theme scan, validation, and the Sitefinity hand-off.

**Landed 2026-10-30, after the first persona review** (`docs/ONBOARDING-PLAN.md`; reviews in the partner's review kit):
- **Content sync** (`apps/worker/src/jobs/content.ts`, the sniffer's `/sitemap` and `/pages`):
  - Pages come from the site's sitemaps, including Sitefinity's `/sitemap/sitemap.xml` and sitemaps up to 50 MB, or from a crawl when there are none.
  - A page budget (200 by default; the ranking is in §5's content plan notes) and include/exclude paths apply, with defaults that leave out search, sign-in, checkout and `/sitefinity`.
  - The sniffer renders each page and keeps its main content (landmarks, then Sitefinity's content placeholders, without navigation, header, footer and cookie banners). It goes into the KB as Markdown under a slug fixed by the URL.
  - Unchanged pages aren't resent, and pages that leave the site leave the KB. Every page carries its status and a reason.
  - Measured: 12 Sitefinity pages were answerable 32 s after the sync started. Link resources, where Agentic RAG fetches the page itself, took 220–235 s each and failed with a CSS selector, so they aren't used.
  - Provisioning starts the first sync, and a daily re-sync follows.
- **Stages from data:** Draft → Provisioning → Indexing (n of N) → Ready to embed → Live, plus Paused, Offline (budget) and Failed. (Superseded after the second review, below: Ready to embed now needs a person's sign-off.)
  - **Ready to embed** = validation passed and the domain lock answers a CORS preflight from every allowed origin.
  - **Validation** = 4 questions generated from the content and asked of the real chatbot; at least 3 must be answered with sources. (Superseded: at least 6 questions, 2 of them the partner's own, 75% answered, no failures, flags acknowledged; §8.)
  - **Live** = the first token issued to an allowed origin, i.e. a visitor's first question, or visitor questions in the usage roll-up.
  - An onboarding checklist and a timer (customer created → ready → live) sit on each deployment; Fleet shows the average.
- **Partner tests:** preview, validation and prompt tests aren't billed. They're sent as `client_type: "dashboard"`, and the usage and question roll-ups leave them out.
- **Editing after provisioning:**
  - Domains update the console and the KB's `allowed_origins` together, with the www/apex twin suggested and the lock checked.
  - The prompt and language: templates (General, Healthcare, Financial services, Education and public sector), a try-before-save box, versions with restore, and a warning when the KB's prompt was changed elsewhere.
  - Where leads go; the customer itself; pausing a deployment or a whole customer; a budget mode (alert only, or stop at 100%).
- **Go-live:**
  - CSP entries for the site, and a list of refused origins with **Allow it**.
  - **Check installation:** the sniffer loads a page, and the console judges the snippet, deployment id, domain (naming a www/apex mismatch), CSP and whether the widget rendered.
  - An **install guide**: Sitefinity MVC page template and JavaScript widget, ASP.NET Core renderer layout, Tag Manager, CSP, connector values for 15.4+, data handling. It can be shared by a read-only link with no keys.
- **Sign-in:**
  - OIDC (Entra ID, Google or any provider with discovery; PKCE; ID tokens verified with `node:crypto`) for invited users with Admin or Member roles.
  - Every audit entry names its person.
  - The shared password remains only as setup mode, behind a banner.
- **Alerts (worker):** sent once each, by webhook (Slack/Teams JSON) and email when SMTP is set, for:
  - budgets at 80% and 100%
  - failed provisioning, syncs and validation
  - a stalled usage roll-up
  - keys 30 and 7 days before expiry
  - undelivered leads
- **Client report:**
  - Per customer and month: questions, answered share, top questions grouped, unanswered questions (content gaps), thumbs, CTA, handoff and lead counts, languages, and quality in words.
  - Built from a masked copy of the question log and the widget's counts-only events endpoint.
  - Read-only share link (never with cost) and print-to-PDF.
- **Leads:** the widget's contact form posts to the console, which delivers to the deployment's webhook and/or email at once, and retries for 7 days before deleting.
- **Fleet:** search, a "Needs attention" filter, stages, linked alerts, a stale-figures warning, and Presenter mode (only one customer's pages while screen-sharing).
- **Not yet:**
  - a single wizard (the checklist stands in for it)
  - client sign-in (the report's share link stands in)
  - Sitefinity Insight events
  - key replacement (alerts at 30 and 7 days)
  - the native Sitefinity AI Assistant path
- **Invites** are built but have only run against mocks.
- **Empty KBs:** Agentic RAG streams `status: no_retrieval_data` and a fixed English sentence. The widget replaces that sentence with its own text in the visitor's language.

**Landed 2026-10-30, after the second persona review** (`review-kit/round-2/proposal.md` and `triage.md`):
- **Review and sign off** (`lib/review.ts`, `/customers/{id}/deployments/{id}/review`):
  - One screen before "Ready to embed": the saved widget over the site's screenshot (desktop and phone, sample and no-answer replies), plus a line per thing visitors meet. The lines are brand, handoff, privacy notice, contact form, starter questions, languages, content, validation, and, for information only, CTAs and GA.
  - Sign-off needs every required line done, or skipped on purpose. Handoff and the privacy link can be skipped, with the consequence spelled out and the person recorded. The privacy link can't be skipped while the contact form is on, and the form needs a lead destination.
  - The sign-off records the person (in setup mode a typed name, marked "not verified") and a hash of everything visitors see (`visitorSettingsHash`: theme, widget settings, prompt, language). A later change shows "Changed since sign-off", with who changed what from the audit log, and keeps serving.
- **Publish gate:** `deployments.published`. Until a sign-off, the config route answers `{ published: false }` and the token route refuses, so the snippet can be installed early and nothing shows. Check installation says the chat waits for sign-off. Deployments provisioned before the gate existed were published by migration 0005 and show "Not signed off".
- **Stages:** Indexing → Ready to validate → Review and sign off → Ready to embed (signed off) → Live. The header follows the latest validation run. Live without a current sign-off is flagged. The checklist gains **Review and sign off**, takes brand and handoff from the review, and stays on a live deployment as one line while steps are open.
- **Knowledge Box allowance** (`lib/capacity.ts`): counted with the NUA key. The limit comes from a PAT (`max_kbs`), or is learned from a 402 at that count, and forgotten once a KB is created past it. It's shown on Settings and New deployment, and Create and Retry are blocked at none left.
- **Provisioning failures in plain words** (`@launchpad/par-client` `provisioningProblem`): 402 limit, 403 rights, 401 key, unreachable, timeout. Each gets a sentence and who acts, with the API's line behind "See why". The snippet, install guide and its share link stay hidden until provisioning succeeds.
- **Alerts:** a failed provisioning alerts once per cause (`provision-failed:<id>:<cause>`), naming the customer and the reason; the key clears when the deployment recovers. A budget crossing 80% and 100% in one roll-up sends only the 100% alert.
- **Pause stops open chats:** `GET /api/public/deployments/{id}/status` (`{ online }`, 15 s cache). The widget checks it before a question when its last check is over 30 s old.
- **Onboarding clock:** start to the first sign-off (the audit log's first `deployment.signoff`) and to the first answer on an allowed domain, as medians. Only signed-off deployments count, so seeded, imported and scripted ones never set the number. The deployment page keeps "Onboarded: …" after Live.
- **Smaller pieces:**
  - "Name visitors see" on the customer (`tenants.displayName`), used wherever visitors see the client's name.
  - Presenter mode hides partner cost, the projection and the budget meter.
  - Share links can only check the deployment's own domains.
  - The install guide's script size is measured at each widget build (`lib/widget-size.ts`).
  - The error summary takes focus and links to each field.
- **Content plan** (`lib/content-plan.ts`, sniffer `POST /plan`): New deployment reads the site's sitemaps without loading pages (every URL with lastmod, priority and hreflang, up to 150,000 pages and 25 s) and shows within seconds:
  - sections with counts and newest/oldest dates
  - languages, with served ones selected and unsupported ones labelled
  - ticked suggested exclusions with counts: conversion, duplicates, archive pages over 12 months, years before last year, not updated in 2 years
  - "the budget takes N; oldest page taken: date"
  - Create stores the plan on the sync source before the first sync. Every sync ranks pages with the same code: served language, specific pages before overviews, turns across sections, newest within each depth. Loading a page adds its date, language and flags (conversion, old, other language, overview, text much shorter than the page). Duplicates and other pages left out after loading are replaced from the ranking. Re-syncs skip pages whose lastmod is unchanged, and first syncs go ahead of re-syncs. A first sync with nothing answerable after 15 minutes alerts once (`sync-waiting:<id>:<start>`). The sniffer gives scans, install checks and the plan their own capacity lane.
  - Measured: telerik.com plan in 3.6 s (150,000 of 390,510 pages read); progress.com/sitefinity-cms 60-page sync done 2 min 15 s after Create.
  - The worker imports `apps/console/src/lib/content-plan.ts` directly (the images copy the whole repo); it can move to a package later.
- **After the release check (three real onboardings, 2026-10-30):**
  - **Deployments take turns:** within first syncs (and within re-syncs), the worker loads a page from each deployment in turn rather than one deployment's whole budget first. Three onboardings at once had each waited about 6 minutes for a first answerable page. The Content panel's "load first" count follows the same order.
  - **Release notes for earlier versions** are a sixth suggested exclusion (`versions`). In a release-notes or changelog folder, pages naming a version below the newest major of the same product are matched (at least 3 versions listed). progress.com dates every release note with the day its sitemap was regenerated, so the 2-year rule let notes for Sitefinity 6 to 14 in: 511 of 1,454 pages under /sitefinity-cms.
  - **Ad-click parameters** (`gclid`, `gbraid`, `gad_*`, `utm_*`, `fbclid`, `msclkid` and the like) are dropped from every URL the sync compares or stores (`withoutTracking`). A canonical tag carrying them had made a Google Ads landing URL a cited source.
  - **One "oldest page taken"**, the sync's own, on the deployment page, review and content list, with the plan's expectation beside it when they differ. The page total no longer counts left-out pages (they're listed apart), so "N of 200 answerable" doesn't grow during a sync.
  - **Domain lock rechecked by the worker** (`jobs/domain-lock.ts`) every minute for 30 minutes after the domains change. It records the result once every domain passes, or after 10 minutes. Allow it no longer leaves a signed-off deployment back at "Validate" until someone presses the check.
  - Page titles a site repeats are said once, and a page-reader script error reads as Launchpad's fault, not as a raw exception.
  - An unpublished deployment's token route answers 403 "Not published yet", not 503, so uptime monitors don't page anyone.
  - The Knowledge Box limit can be entered in Settings when there's no PAT (source `entered`).

**Landed 2026-10-30, after the third persona review** (`review-kit/round-3/proposal.md` and `triage.md`). The rule for the cycle: nothing goes green that the product didn't check, and no price reaches a visitor unchecked.
- **Finding the sitemap:** a sitemap address typed on New deployment or in Content settings is read directly. Otherwise robots.txt's sitemaps are read; when they're on another host (kemptechnologies.com's point to www.chef.io) or list none of the site's pages, `/sitemap.xml`, `/sitemap/sitemap.xml` and `/sitemap_index.xml` are tried too, and the plan says which file it used and why. With no pages, the first sync follows links from the address (up to the budget, 3 clicks deep), Create works, and the deployment's own language counts. Measured: kemptechnologies.com 7,553 pages (2,286 English) in 0.7 s.
- **The page's own dates:** JSON-LD (nested dates included), article meta tags, then `<time itemprop>`, stored apart from the sitemap's lastmod (`content_pages.publishedAt`, `pageModifiedAt`, `sitemapLastmod`). Articles go by when they were published. The 2-year and 12-month rules apply as each page loads, the next candidate replaces anything they leave out, and the plan's figures are labelled estimates.
  - **Bulk-stamped sitemap dates** (a day shared by at least 10 of a folder's pages and a quarter of its dated ones) count as unknown, and the plan names them ("155 pages in /webinars share the sitemap date 29 Jun 2026"). Such pages go by dates in the address.
  - **Stale prices:** articles that state a price, offer or version and were published over 12 months ago are left out; other pages get the `stale-commercial` flag. Event pages count as archive pages; a page named for an earlier version (`/13-3-lts`) falls under the release-notes rule. Undated sections are sampled across their pages, not alphabetically.
- **Versions and Bring up to date:** each page records the extractor and rules versions that read it, and "unchanged" needs both current. Outdated pages were read again nightly (02:15 UTC, at most 2,000, behind every sync); since the sixth review, Bring up to date overnight does it instead, a deployment at a time with its re-check (below). A re-read never takes an answerable page out by itself: it records why today's rules would. Sign-offs record `checksVersion` (`CHECKS_VERSION`, 2 then, 3 since the fourth review). Older ones keep serving, flagged on Review, the deployment page and Fleet, until **Bring up to date** (re-read and today's rules page by page, the current prompt before and after, validation again) and a new sign-off. "Not updated in 2 years" isn't applied to deployments without a plan: their sitemap dates are all they have.
- **Client's name** (`lib/client-name.ts`) reads what's saved and served: the prompt (and the Knowledge Box's own when it was changed in the dashboard), every widget string in every language, and the lead email. It's Done only with the visible name in the prompt, no internal or earlier name anywhere, and no prompt line from the leak list. **Update the prompt** shows before and after and keeps the partner's own lines. "Name visitors see" is required and stored; a change to it holds sign-off and offers **Update all** on the customer page.
- **Staging domains** are marked per domain (extra domains default to staging; localhost always counts). The stage says "Live on staging (host)" or "Live on host", and staging traffic is test traffic (§8).
- **Pages added by hand** (validation's Add these pages, Content's Always include): kept outside the budget and the plan's rules, up to 25, and loaded first. **Queue order:** added by hand, first syncs, re-syncs, the nightly re-read; about 60 pages a minute in three batches side by side. The checklist shows the time left and what to do meanwhile.
- **Capacity:** "N of M used, K left" plus the deployments waiting for a Knowledge Box, a warning at 90%, and the limit asked for at first-run setup.
- **Check installation** passes nothing it didn't see:
  - It reads nonces, hashes and `'strict-dynamic'`: listed hosts don't count there; a nonce'd tag or loader does.
  - The page's own render wins over its reading of the policy, both ways.
  - A domain whose lock Agentic RAG hasn't applied yet says so ("still applying it, usually 1 to 3 minutes").
  - An excluded page or Sitefinity's page editor says the chat stays off there by design.
- **Focus:** after each in-page action (save, confirm brand, add a contact, generate, choose starters, use these, edit and run again, allow it, check installation, sign off), focus moves to the result or to the control that replaced the button (`components/focus.tsx`).

**Landed 2026-10-30, after the fourth persona review** (`review-kit/round-4/proposal.md` and `triage.md`). The rule for the cycle: every "Answered", "Passed" and "Done" is true, each site's key pages are in the default sync, and a sign-off made mid-sync still holds after the sync ends.
- **Key pages:** before sections take turns, the plan takes pages whose address names price, buy, contact, support, a trial or an FAQ (with translations), one or two levels deep after any language folder, then deeper ones. Never from article folders (blog, news, press, webinars, whitepapers). At most 4 per intent and language, and an eighth of the budget, up to 25. This cycle they come from addresses alone: the scan doesn't return header and footer links. The plan shows a Key pages line, and Content labels each key page with its intent.
- **Never left out by age alone:** key, FAQ, help and support pages are exempt from "not updated in 2 years". The stale-price rule is unchanged.
- **The intent line:** at ingest, a key page's text gets one line naming its intent in the page's language ("About this page: how to contact us, including sales and support."), so /contact answers "How do I contact sales?" though it never says "sales".
- **Keep it anyway:** Always include and Add these pages ask first when a page trips a date or stale-price rule ("This page states a price and was published 11 Oct 2016. Keep it anyway?"). The page is kept only with a reason and a name (typed, in setup mode), stored in `sync_sources.kept`. Review shows "Check this: 1 page kept by hand despite a stale price", with who and why; it doesn't hold up sign-off.
- **The fix panel** matches on one intent word, with synonyms, and lists key pages first: "contact" finds /contact.
- **The sync's tail:** once 5 replacements in a row are also left out, the sync stops replacing and finishes. The same "about N min" is never shown for longer than N minutes.
- **`RULES_VERSION` 2** (6 now), guarded by `rules-version.test.ts`, which fails when the rules' output changes without a bump.
- **Live deployments keep today's selection:** a published deployment signed off under checks before 3 keeps the selection from before key pages until Bring up to date's **Add** switches it (the `content.key-pages` audit entry the worker reads).
- **Bring up to date** has five steps, each with its before and after, and each acting only when its button is clicked: today's rules (Apply); key pages (**Add**: which key pages join and which pages at the end of the budget leave; a typed name in setup mode); the prompt (**Update the prompt**, when the saved prompt lacks the no-answer line or the quote line); validation again, with the intent questions in place of generated questions that left nothing open; then Review. Opening it records nothing. As before, it queues outdated pages to be read again, and they stay in the chat meanwhile.
- **Content changes count as changes:** pages added, kept or left out by hand after the sign-off, key pages added and content settings changed (`contentChangesSince`), where they still differ, put the deployment at "Changed since sign-off" on its page, Review and Fleet, like a change of the client's name. Review lists each with who and when, and offers "sign off the changes"; they don't hold up sign-off themselves.
- **History** words every audit action (a test fails when one has no words), calls the worker's runs "The automatic re-run", and names a setup-mode entry by the name typed with it, or else the last one typed before it, marked "(not verified)" once.
- **Keyboard and WCAG** on this cycle's screens: focus moves to the result or the next field after I checked it, The site doesn't cover this (to the reason), Add these pages, Always include, Remove (to the reason, when the question had a problem), each Keep it anyway step (validation, starter picker, Content), ticking a starter (to its answer) and Cancel in the picker. Add your own moves focus to the new field, so typing goes there instead of each space pressing the button again and adding an empty row. The question editor's Remove buttons name their question. Source links under validation answers are at least 24 px tall with space between (WCAG 2.5.8). `.table-wrap` is `position: relative`, so the table's visually hidden labels no longer widen the Content page at 390 px.

**Landed 2026-10-31, after the fifth persona review** (`review-kit/round-5/proposal.md` and `triage.md`, with `docs/ANSWER-QUALITY-PLAN.md`). The rule for the cycle: a reply is judged against the site, not its wording, and nothing reaches a signed-off chat without a re-check.
- **Page-type labels:** the worker labels each resource it sends in `usermetadata.classifications`, labelset `launchpad_page` (`price`, `buy`, `contact`, `support`, `trial`, `faq`, `events`; `PAGE_LABELS` in `content-plan.ts`). They're what the intent configurations (§6) filter on.
- **The intent line moves to metadata:** the "About this page: …" line is no longer in the page text, so an answer can't quote it; it's kept in the resource's metadata for routing.
- **Dates without a year are placed at ingest:** "Thursday, November 5" is read as its next occurrence on or after the page's latest date (published, updated or sitemap), and must agree with the weekday; the text sent carries the year. Content shows how each date was read ("Read as 5 November 2026, from the sitemap date"), and flags a date it couldn't place.
- **Key-page facts:** `content_pages.facts` holds each synced page's price lines, contacts, links and upcoming events (with `readAs`), refreshed on every read; validation's evidence check reads them.
- **The home page and top-level section pages** aren't left out by age alone, like key and FAQ pages.
- **The pages panel** searches the synced pages' text, shows near misses, and holds Content's **Find a page**, prefilled with the question's words.
- **Retract on upgrade:** pages left out by hand that were still in the Knowledge Box are taken out after an upgrade, with one alert per deployment.
- **Add during a re-read** restarts the running sync with the key pages in it, and History records the pages that actually joined and left.
- **`EXTRACTOR_VERSION` 3 and `RULES_VERSION` 4** (both 6 now), guarded by `rules-version.test.ts`.
- **Validation and the starter picker** hold more than the shared verdict (§8) can see, and can only hold a result, never release one: the evidence check (a price answer that gives none of the pricing key page's figures, or says the site lists none; "no upcoming event" while a synced page has a future date; "no phone or email" while the contact page lists one) and a model judge (`judgeAnswer` in `lib/judge.ts`: Agentic RAG's `/predict/chat` with the account key, JSON at temperature 0, cached per question and answer in `judgements`). A hold clears only by asking again and getting an answer, rewording, or a named decision.
- **What validation asks:** each intent twice, in a generic phrasing from the visitor phrasing bank (`PHRASING_BANK` in `validation-rules.ts`, versioned, in en, de, fr and es) and by the visible name, shown as a pair; and the events questions when a synced page has an upcoming event.
- **Answering rules are versioned** (`ANSWERING_RULES` in `prompt.ts`, `deployments.answering_rules`, guarded by `answering-rules.test.ts`). The hourly push is retired. A new version reaches a signed-off chat only after the worker's `rules-rollout` job re-asks its last validation set and live starters: nothing worse, it's applied ("applied after a re-check: 14 of 14 unchanged or better"); anything worse, it's held (`deployment.rules.held`), with one alert. The daily job refreshes only the date, and keeps the events wording a prompt was saved with.
- **Review's side-by-side:** a held deployment's Review shows each answer that got worse, under the rules it runs and under the new ones (the hold's `worse[]`), and a named person (a typed name in setup mode) can **Switch to answering rules vN**, audited as `deployment.rules.applied` with the name.
- **New deployments route from the start:** provisioning saves the intent configurations beside the default one and records the latest answering rules, instead of waiting for the rollout.
- **Setup-mode names:** the name is typed once per session (a session cookie set by the name fields, `components/typed-name.ts`), and every audit entry setup mode writes without a name of its own records it (`lib/setup-name.ts`), so History, Review, Bring up to date and alerts name the person; Review's change lines go by History's rule (`historyActor`, with `typedNear` for entries that recorded none).
- **Bring up to date:** step 1's button says what it does ("Apply: leave out 4", or "Apply: nothing to leave out"); its result says how many pages were left out and how many proposed ones were kept, never "0 of 0 proposed"; and each step's result takes focus when its button brings the page back.
- **The agents pilot:** the account setting **Improve answers with Agentic RAG agents** (off by default) has provisioning create a `synthetic-questions` agent and an `ask` agent ("what this page answers") on a new deployment's Knowledge Box, and turning it on for an existing deployment sends its pages through processing again. Whether the generated text can be cited isn't set in the search configuration yet.

**Landed 2026-11-01, after the sixth persona review** (`review-kit/round-6/proposal.md` and `triage.md`). The rule for the cycle: check answers against what the product already knows (a confirmed price table, key pages checked to load, the synced pages), not against phrase lists. This is what the code does and what its tests cover. None of it has been seen live by a verifier yet.
- **Site reading:**
  - **Gzipped sitemaps:** the sniffer gunzips any body that starts with gzip's bytes, up to 60 MB unpacked (`decodeBody` in `apps/sniffer/src/net.ts`). That covers `.gz` files and sitemap indexes that list them. The sitemap address on New deployment and in Content settings accepts `.gz` (`lib/content-form.ts`).
  - **429 pacing:**
    - **The sniffer** paces page loads per host (`apps/sniffer/src/pace.ts`). After a 429 or 503, that host is loaded one page at a time. The gap between loads starts at 0.6 s and doubles with each further refusal, up to 5 s. The page is tried again after its `Retry-After`, or after 2 s, then 4 s, up to 3 tries. A wait over 15 s isn't waited out: the page comes back rate-limited.
    - **The worker** holds that host's pages until the `Retry-After` (at least a minute), then sends at most 5 a run for 15 minutes.
    - **A rate-limited page** waits for a later run, up to 4 tries. After that, a page already in the chat goes back to answering from its copy, and any other page fails with the reason. The next sync tries both again.
    - **The Content header** names the rate-limited pages instead of calling them failed (`rateLimitedNote`).
  - **Honest outcomes:**
    - **An incomplete listing takes nothing out of the chat** (`listingComplete`). Incomplete means a sitemap file failed, went unread or was blocked, or a crawl found under 80% of what's answerable now.
    - **Unreadable sitemaps:** when sitemaps read before can't be read this time, the sync stops there and keeps its pages, rather than crawl instead (`SitemapUnreadable`).
    - **A sync that can't start** is recorded as failed, which alerts, only when the chat has no answerable page. Otherwise it's partial: its pages are kept, the reason is shown, and the next scheduled sync tries again (`startFailure`).
  - **Key pages by kind, checked to load (`RULES_VERSION` 6):**
    - **Pricing:** /plans and /plans/* are pricing pages. `isPricingPage` also takes /buy, /how-to-buy, /purchase and titles such as "Plans & Pricing". It doesn't take quote forms, FAQs, or pages in article folders.
    - **Support:** a support word last in an address names a support page only after a word saying whose support it is: /technical-support counts, /regulatory-compliance-support (a feature page) doesn't.
    - **Events:** the events section's own pages (/events/<event>) are taken right after the key pages.
    - **The load probe:** the plan, and a first sync, probe the key pages through the sniffer's `/probe`. One that answers 4xx or 5xx, or with a block page, gives its place to the next page of its intent. The sync does this for up to two rounds.
  - **Bot protection** (`apps/sniffer/src/blocked.ts`):
    - **What counts:** robots.txt, the sitemaps and the start page are checked for a challenge or block page (Cloudflare, DataDome, Imperva, HUMAN, Kasada, AWS WAF, Sucuri, Akamai, F5). A bare 403 block page counts on the start page only, and an HTML cookie wall counts where robots.txt or a sitemap should be.
    - **What happens:** a sitemap read stops at the first blocked file. The plan answers early when the start page is blocked, and says "The site blocked our reader (…)… Ask the client's web team to allow the crawler" before anything is created.
    - **While the plan loads,** it shows what it's doing and the seconds so far.
  - **The held-answer panel** says "Adding pages won't help" only after a complete sitemap read. Otherwise it points to Find a page.
- **The price table** (`lib/price-table.ts`; `deployments.price_table` and `price_table_confirmation`, migration 0010):
  - **Built after each sync** (`refreshPriceTable`) from the facts stored for the deployment's pricing pages, chosen by address or title (`isPricingPage`).
    - **A row:** each "Plan: figure …" line becomes a row: plan, amount, currency, unit ("per node"), period (month, year or once), and qualifiers ("from", minimums, "billed annually", list price). Each row keeps its page and line.
    - **Borrowed details:** when a page states a unit or period for its other plans only, the row borrows it and says so.
    - **Two prices for one plan** are labelled as a billing toggle.
    - **Languages:** pages in the deployment's language come first.
    - **Badges** ("Most popular" and the like) are ignored when plan names are read (`EXTRACTOR_VERSION` 6).
  - **Written only when its rows change,** audited as `deployment.price-table.read`. Rows a person corrected stand while every other row reads the same.
  - **The confirm step:**
    - **The card,** on the deployment page and on Review, shows the rows with an Open link to each pricing page. It offers **This matches the pricing page**, with the person's name (typed in setup mode), and per-row edit. An edit confirms the table as corrected. Both are audited.
    - **One hash:** the confirmation holds for one hash of the rows. A re-read that changes them shows "Price table changed: confirm it again" on Review and in Needs attention. A live chat whose table was never confirmed is in Needs attention too.
    - **No table:** with no pricing page, or prices by quote, there's no table. Review says so, and sign-off isn't held for it.
  - **The claim check** (`checkPriceClaims` in `packages/theme/src/price-claims.ts`): pure, and bundled by the widget. It runs only against a confirmed table (`confirmedTable`).
    - **Contradictions:** a table plan given another amount than its rows give (a monthly row times 12 counts as the yearly amount); a table plan's amount cited from a page that isn't a pricing page; or a reply saying a listed plan's price isn't stated. A reply that names no plan and no amount but says no prices are listed contradicts the first row.
    - **Prices to check:** an amount no row has stays a price to check, as before.
    - **Where it runs:** live in the chat for price questions (§6), and in validation, the picker and the overnight re-check (§8).
- **Bring up to date overnight** (`apps/worker/src/jobs/rules-rollout.ts`, every 10 minutes): one job replaces the answering-rules rollout and the 02:15 re-read batch.
  - **Pacing:** between 00:00 and 06:00 in the server's time (deployments have no time zone of their own yet), at most 2 deployments a run.
  - **Which deployments:** those whose pages were read by an older extractor or rules (Fleet's "Read the pages again for all, tonight" pages included), or that are on older answering rules.
  - **The re-read:** each deployment is read again by Sync now's re-read path, and its pages stay in the chat meanwhile. A re-read that hasn't finished in 30 minutes lists its unfinished pages, and the job goes on to the re-check.
  - **The re-check:**
    - **Not signed off:** everything is applied.
    - **Signed off:** its last validation set and live starters are asked under the latest rules and judged as validation judges, the price table check included (`recheckUnderLatestRules`).
    - **Nothing worse:** the answering rules and today's leave-outs are applied.
    - **Anything worse,** confirmed by a second ask: it's held, and re-checked after 24 hours.
    - **Audit:** each step is audited as `deployment.uptodate`.
  - **The old batch:** the 02:15 UTC batch is still scheduled but reads nothing (`REREAD_PER_NIGHT` 0). The console's Content page, Bring up to date and Fleet still say "02:15 UTC" for queued re-reads.
  - **A forced run:** the review environment forces one with `apps/worker/src/jobs/bring-up-to-date-now.ts`, with deployment ids to limit it and `--wait` to repeat it.
  - **Deployments not signed off** take new answering rules at any hour.
- **Versions:** `EXTRACTOR_VERSION` 6 and `RULES_VERSION` 6 (`content-plan.ts`), guarded by `rules-version.test.ts`. `ANSWERING_RULES` stays at 4. The triage planned a v5 prompt change ("don't name pages as links"), but it wasn't made, so the renderer (§6) is the only guard against links the model writes.

1. **Detect** (sniffer), plus the style scan (§7):
   - Sitefinity from `data-sf-` attributes and Sitefinity resource paths, since the `generator` meta tag is often stripped. Ask the partner for the version.
   - `sitemap.xml` via `robots.txt`, with the page count.
   - Languages from `hreflang`.
   - Logo and favicon.
2. **Plan** (shown before anything is created):
   - KB slug `<partner>-<customer>-<site>`, models from the partner template.
   - Content path: **Sitefinity connector** when version ≥ 15.4.8626, otherwise **sitemap sync**. A partner can add both, plus SharePoint/S3 sources. Sitemap sync shows the page count, takes a page budget and URL include/exclude rules, and needs confirmation above a threshold. Real Sitefinity sitemaps run to thousands of pages: crayola.com lists 5,438.
   - Widget path: **`<arag-chat>`** (default, themed) or Sitefinity's native AI Assistant widget.
3. **Execute** — each step idempotent, logged and resumable:
   1. Create the KB with `allowed_origins` = site domains (prod + staging).
   2. Create the default search configuration (persona, site-only grounding, citation rules, language behavior).
   3. Create three service accounts, all encrypted at rest:
      - **reader**: mints browser tokens
      - **writer**: Sitefinity connector and ingestion
      - **manager**: search configs and analytics
   4. Create the sitemap connection + sync config and trigger the first sync (if on that path).
   5. Save the theme from the style scan.
4. **Validate:**
   - Wait for N resources to process.
   - Generate 4 starter questions from the indexed content, run them as smoke tests, and show answers with citations.
   - Poll a CORS preflight from each customer domain until it passes. Domain-lock changes take 15–60 s to apply.
5. **Hand-off:**
   - Sitefinity 15.4+: the three values for _Agentic RAG connection_ (endpoint **without** `/api`, KB UID, writer key), with a copy button each and illustrated steps.
   - Embed: a one-line `<script src="…/arag-chat.js" data-deployment="…" async></script>` plus where to put it in Sitefinity (layout template or Script widget). Theme and settings load at runtime, so restyling never needs a re-embed.
   - A downloadable hand-off sheet for the customer.

## 6. `<arag-chat>` widget

- A plain custom element (no framework) in shadow DOM, bundled by esbuild into one classic script, so `document.currentScript` works in the embed snippet. Budget **≤ 45 KB gzipped**, enforced by the build (raised from 40 KB on 2026-10-31, when the verdict's claim patterns and seven languages of strings reached 40 KB; moving the strings into the public config is the next way down).
- Four display modes, chosen per deployment:
  - **Embedded:** an ask box in the page flow. Answers appear underneath one at a time, and follow-ups still carry the conversation.
  - **Chat:** the whole conversation as a panel in the page flow.
  - **Popup:** an ask bar in the page that opens the conversation in a modal `<dialog>` above the content.
  - **Floating** (default): a chat button in a corner of the viewport that opens a panel above it.
- Embedded, chat and popup render where the `<arag-chat>` element is placed. Any page element with `data-arag-chat-open` opens the chat, such as an "Ask us" link in the site's navigation, and the element exposes `open()` and `close()`.
- Three finishes for the launcher, buttons, visitor messages and header:
  - **Flat:** solid fills.
  - **Gloss:** a white sheen over the top half, with lit edges.
  - **Gradient:** the primary color running into a second stop, sniffed from the site or derived from a neighbouring hue.
- The theme package keeps every finish at AA. It adjusts the gradient's second stop, or the base under the gloss sheen, until text passes 4.5:1 across the whole fill.
- Welcome message, starter questions, streaming answers, markdown, source citations, thumbs feedback (`/kb/{kb}/feedback`), and an AI disclosure line.
- **Avatar:** an https image, usually the site's logo or icon from the scan, beside the chat name.
- **Handoff to a person** (landed 2026-10-30):
  - Contact links: a web page, a phone number or an email address.
  - Where it shows is set per deployment: after a reply with no answer (or an error), as a "Talk to a person" button in the header, and as a "Still need help?" line under every answer.
  - Contacts carry a `kind`, so opening the site's live chat or an in-chat form can be added later.
- **Call-to-action buttons** (landed 2026-10-30): each has keywords, and appears under a reply whose question or answer mentions one, ignoring case and accents. At most two per reply.
- **Analytics** (landed 2026-10-30):
  - Every event is an `arag-chat:event` DOM event on the element.
  - With GA turned on, events also go through the site's own gtag (with `send_to` when a measurement ID is set) or Tag Manager's `dataLayer`. The widget loads no script.
  - Events: `arag_chat_open`, `arag_chat_question`, `arag_chat_answer`, `arag_chat_source_click`, `arag_chat_cta_click`, `arag_chat_handoff_click`. Each carries `deployment_id`.
  - Question and answer text are never sent.
- **Links:** every link the partner configures is checked twice, by the console and by the widget: https, http, `mailto:` or `tel:` only.
- **Search configuration:** the widget asks with the deployment's saved configuration. Deployments imported from existing KBs have none from the console, so they ask with the KB's own defaults; asking with a missing configuration is a 400 (verified 2026-10-30).
- Accessible: focus management, ARIA live region for streamed text, full keyboard use, reduced-motion support, and AA contrast enforced by the theme package.
- Theming in three layers, from easiest to most powerful:
  1. **Design tokens** as CSS custom properties (color, typography, radius, shadow, spacing, launcher, finish).
  2. **`::part()` hooks** on every structural element (launcher, panel, header, message, bubble, input, send, citation, chip).
  3. **Custom CSS** injected into the shadow root, for anything else.
- Fonts: `@font-face` rules on the host page are usable inside the shadow root, so the widget uses the site's own fonts without loading or redistributing anything.
- Runtime flow:
  1. `GET /api/public/deployments/{id}/config` → theme, strings, KB, zone, search config name.
  2. `POST /api/public/deployments/{id}/token`. The console mints a reader-scoped ephemeral token (`POST /ephemeral_token`, ~15 min TTL) for the chat session. The widget refreshes it on 403 or near expiry.
  3. Stream `/ask?eph-token=…` directly from Agentic RAG, which only accepts this token as a query parameter. In M0 the first answer text arrived about 0.9–1.8 s after the request.

**Landed 2026-10-30, round 2:**
- **No answer:** a reply is "no answer" when Agentic RAG reports `no_context` or `no_retrieval_data`, or when its best reranked paragraph scores under 0.02. The threshold was measured on a real KB: answerable questions scored 0.13–0.49, off-topic ones 0.004 or less. An uncited reply counts as no answer only when there's no reranker score, because citations came back empty for good list answers. The widget asks with `citations: true`.
- **Answers:** a safe Markdown subset rendered with DOM calls, never innerHTML. Links go only to the client's own sites. Sources are labelled, with the domain shown on off-site ones.
- **CTAs** match whole words, plurals included ("cost" doesn't match "costume"); matching inside words is opt-in per button.
- **Visitor features:** thumbs under each answer, Try again after an error, and the conversation kept per tab in sessionStorage. No cookies.
- **Contact form:** in the chat, posting to `/lead`. Events go in batches to `/events` (text/plain, sendBeacon on pagehide), each with a `conversation_id`, and carry only counts and flags.
- **Handoff suggestions:** the widget page offers the site's contact page (from the synced pages) and the customer's primary contact as one-click contacts. Nothing is added without the partner.
- **Copy and languages:** "auto" follows the snippet's `data-language`, then `<html lang>`, then the browser, limited to `settings.languages`, with per-language copy in `settings.translations`. Partners can reword the widget's own strings (`settings.copy`).
- **Privacy and placement:** a `privacyUrl` link in the disclosure line, and `exclude` path patterns. The widget doesn't render in Sitefinity's page editor (MVC `/Action/Edit` and the `sfPageEditor` body class; `sfaction=edit` and `data-sfcontainer` in the ASP.NET Core and Next.js renderers).
- **CSP:** styles are constructable stylesheets, so the widget works under `style-src 'self'`. A failed config load logs one `console.error` naming the cause: the origin refused, the CSP directive that blocked it, or the console unreachable. The config route's refusals carry CORS headers so the widget can tell them apart.
- **Theme:** control borders at least 3:1 and secondary text and links at least 4.5:1, on both the panel and answers. The chat button gets an outline when its fill is under 3:1, and `launcher.bottom` sets its own offset.
- **Tests:** browser tests with axe on all four layouts in `packages/widget/e2e` (run in CI), and strict-CSP pages in `spike/csp`.

**Landed 2026-10-30, after the second persona review:**
- **Phone:** the floating panel is a `<dialog>`, opened with `showModal()` on phones (480 px wide or less), so the page behind is inert, Tab stays inside and the launcher is hidden. Escape, Close and Android's back gesture return focus. On desktop it stays non-modal.
- **Cookie bars:** the launcher lifts above fixed or sticky bars along the bottom edge (OneTrust, Cookiebot, Sitefinity's banner), and drops back when they close (`liftAboveBars`, on by default).
- **Publish gate:** a config of `{ published: false }` renders nothing and logs one line saying the chat waits for sign-off.
- **Pause:** before a question, the widget checks `/status` when its last check is over 30 s old, so Pause ends open conversations within a minute.
- **Answer events:** `arag_chat_answer` and `arag_chat_feedback` carry `question_hash` to the console only, never to GA, so the report uses the widget's own verdict (§8).
- **Leads (schema v2, `docs/leads.md`, `docs/lead-payload.schema.json`):**
  - `consent`: the exact wording, language, privacy URL and time. The server accepts only wording the deployment actually shows.
  - `trigger`: placement and CTA label, checked against the deployment's buttons.
  - `attribution`: landing page, referrer, `utm_*` and `gclid`, captured into sessionStorage on the visit's first page and sent only with a consented lead.
  - The v1 fields stay. The subject uses the name visitors see.
- **Avatars** may be inline-SVG `data:` URLs: the header logo the scan found, percent-encoded, at most 16 KB, with nothing that runs.

**Landed 2026-10-30, after the release check:**
- **Header:** the name comes first. When the name and "Talk to a person" don't both fit, the button becomes a named icon with a tooltip; only then is a long name cut, never below 4em. Tested in en and de at 1280 and 390 px, and in every language.
- **Phone breakpoint:** an open panel switches between modal and non-modal when the window crosses it, keeping the conversation and focus.
- **Pause:** an offline chat checks `/status` again every 30 s while in view and when opened, so Resume reaches chats already open.
- **Languages:** where the KB holds pages in several languages, the widget asks in the question's language first (`filter_expression` on the resource's main language, from `contentLanguages` in the config). A reply with no answer is asked once more across all pages, without chat history: Agentic RAG rewrites follow-ups that carry history, and the rewrite can miss the right pages.
- Translations can carry per-language button and contact links.
- `preview()` draws inert stills (the header, or the welcome and starters) for the console's Confirm brand and starter picker, so the console never imitates the widget's layout.

**Landed 2026-10-30, after the third persona review:**
- The answer event carries `attempts` (2 when the widget asked again) and `origin`, to `/events` only.
- When an ask fails at the network level and an opaque request to the same address gets through, Agentic RAG hasn't applied the domain lock yet. The chat says "Almost ready" (every language) with Try again, not "Something went wrong".

**Landed 2026-10-30, after the fourth persona review:**
- **The verdict** is the shared one (`verdict.ts`, §8), run in the browser: a reply that says the site lacks the information and gives nothing concrete is no answer (`declined`), shown as written. The GA event's `answered` is that verdict.
- **Handoff:** the contacts and **Send us a message** show under any no answer, declined replies included, and under a Check this reply that tells the visitor to contact the team (`tellsToContact`). Never when a contact or quote button is already under the reply: one way to reach the team, not two.
- **Sources:** at most 2, each related to the question (else the answer) by its title or its own passages; a passage several pages repeat, like a "Watch a demo" band, doesn't count. In the visitor's language when a source in it is there. When none fits, none shows.
- **The question event:** as a question is asked, the widget posts `{ type: "question", conversationId, questionHash }` to `/events` with `keepalive`, kept until it goes through and sent with the beacon on `pagehide`. The console stores one row per conversation and question (`question_events`), so the page's origin is known even when the tab closes a second after the answer. The answer event is unchanged.

**Landed 2026-10-31, after the fifth persona review:**
- **Intent routing:** the widget picks the intent configuration (`launchpad-default-price` and so on, served as the public config's `intentConfigs`) from the question's intent words in seven languages (`questionIntents` in `relevance.ts`), and asks again with the default configuration when the routed ask brings no answer or fails.
- **Grounding** (the shared verdict, §8) checks a reply's figures, dates, links and steps against the passages it cites, read from the stream's augmented context where it sent one, else the retrieved paragraph; a grounded reply shows whatever its relevance score. A reply that may not answer shows as written, with the handoff.

**Landed 2026-11-01, after the sixth persona review** (not yet seen live):
- **Prices, checked live** (`packages/widget/src/prices.ts`). The check runs in the visitor's browser, because the widget asks Agentic RAG directly and no console server is in the answer's path.
  - **The table:** the public config carries the confirmed price table (`priceTable`), and only while its confirmation matches the rows (§5).
  - **Holding the reply:** for a price-intent question (`questionIntents`) on a deployment with a table, the widget holds the streamed text until the answer is complete, showing only the cursor. Then it runs the shared `checkPriceClaims`.
  - **A contradiction is never shown as written.** The visitor gets the table's rows for the plans the question names instead (every row, up to 12, when it names none), each with its unit, period and qualifiers. The reply cites the pricing page, carries the pricing or quote button, and counts as answered.
  - **Other questions** stream as before.
- **One renderer for model text** (`parseModelText` and `renderModelText` in `packages/theme/src/render.ts`). The widget renders its blocks with DOM calls; the console renders its HTML in validation, the starter picker and Review.
  - **Links:** `[text](target)` becomes a link only to one of the deployment's synced pages or a call-to-action or handoff target. The public config carries the synced paths (`pagePaths`, key pages first, at most 300); beyond that cap, any page on the deployment's own sites is allowed.
  - **Targets that aren't addresses** link to the cited page titled like the text, or the synced page named like it. Otherwise the text stays plain.
  - **What becomes plain text:** `[text](#)`, unsafe schemes, and pages on other sites.
  - **What goes:** stray brackets, footnote markers, images and reference definitions.
  - **The validation note:** when the renderer had to repair something, validation shows "Formatting the chat couldn't show: rendered as plain text." It's a note, not a hold.
- **Held replies:** a deflection or a substitution (§8) isn't an answer. It's shown as written, with the handoff card, like a reply that may not answer.
- **Size:** 44.7 KB gzipped in the build of 2026-11-01, against the 45 KB budget.

## 7. Style sniffer

Goal: in about 10 seconds, produce a theme good enough that most partners only nudge it.

**Capture.** Playwright loads the URL at desktop and mobile widths, waits for network idle and `document.fonts.ready`, and takes screenshots for the editor background.

**Signals**, highest confidence first:

1. CSS custom properties on `:root`/`body`. Sitefinity and Bootstrap-based themes often expose `--bs-primary`, `--bs-font-sans-serif`, `--bs-border-radius`.
2. Computed styles of the **primary button**. Candidates are `button`, `.btn`, `[type=submit]` and CTA-like links, scored by visibility, size, frequency and saturation. Captured: background, background image, text color, radius, padding, weight, shadow, plus hover via forced `:hover`. A gradient background image proposes the gradient finish with its first and last stops; translucent white over a solid fill proposes gloss.
3. Typography: body and heading `font-family` (checked against `document.fonts` to confirm the face actually loaded), size, line-height, weight, letter-spacing.
4. Links, inputs (border, radius, focus ring), header/nav and footer colors.
5. A palette clustered from frequency-weighted computed colors in OKLCH, classified into primary / accent / surface / text / muted / border.
6. Logo (header `img`/`svg`), favicon and `apple-touch-icon` as avatar candidates.

**Output.** A `theme.json` of tokens, each with a confidence score and its source selector. Contrast is auto-corrected to WCAG AA. A dark variant is produced if the site responds to `prefers-color-scheme`.

**Theme editor.** A live `<arag-chat>` preview over the captured screenshot (most sites forbid iframing), with token controls, a parts inspector, and a raw CSS tab. Low-confidence tokens are highlighted for review.

**Landed 2026-10-30: the widget page** (`/customers/{id}/deployments/{id}/widget`):
- **Scan:** any public page of the site, through the sniffer. The latest scan is kept per deployment in `site_scans`, with its screenshot. The proposed theme fills the fields unsaved, and each value shows where it came from, highlighted below 0.6 confidence.
- **Controls:** layout, finish, colors (with the contrast repairs listed live), type and shape, name and avatar, text, the handoff, call-to-action buttons, Google Analytics, and custom CSS.
  - Custom CSS goes inside the shadow root after the widget's own styles, up to 10,000 characters, with no `@import`.
- **Preview:** the real widget in a frame over the screenshot. The draft is posted into it by `postMessage`, and theme-only changes restyle without losing the conversation. Replies can be:
  - a sample answer, streamed in Agentic RAG's own format
  - the no-answer reply
  - live answers from the KB, which the console relays because the KB only accepts browsers on the customer's domains; they count toward the customer's usage
- **Save:** writes `theme` and `widget_settings`, and audits the changed keys (`deployment.widget`, and `deployment.scan` for scans). Sites pick it up within the config's one-minute cache.
- **Verified:**
  - A scan of www.progress.com took 9.6 s and recognised Sitefinity.
  - The saved settings read back through the public config route.
  - A live answer came from a real KB through the relay.
- **Not yet:**
  - the parts inspector
  - scans as part of provisioning (since built: New deployment runs the scan alongside the content plan; it applies nothing)
  - a dark variant
  - live chat and form handoffs

**Landed 2026-10-30, round 2:**
- **Primary colour:** media and carousel controls, consent-banner buttons and chat widgets are ignored. Size, position above the fold and the hero's first big call to action count for more than repetition. A single button is never above 0.5 confidence, and "not found" is flagged like a guess.
- **Screenshot:** taken after hiding consent walls and chat widgets.
- **Suggestions:** the scan proposes a chat name and logo, and lists the hreflang languages and web fonts. The preview loads those fonts where their host allows, and otherwise says which font it couldn't load.
- **Widget page:** Essentials and Fine-tune, a Desktop and Phone preview, plain-language sources and contrast repairs, and a prompt before leaving with unsaved changes.
- **Regression set (2026-10-30, first pass):** the main call to action's colour on 8 sites, later rechecked in the scan corpus below.

**Landed 2026-10-30, after the second persona review:**
- **Logos:** only an image or inline SVG that links home and sits in the header, banner or a top navigation block is preselected. `apple-touch-icon` and `rel=icon` are alternatives. `og:image` is a "Check this" option, never preselected. Content images are never offered.
- **Chat name:** compared across the title, the logo's alt text, `og:site_name`, structured data and the domain, with each source shown when they disagree.
- **Privacy URL:** from the footer, matched by privacy words in about 20 languages.
- **Bottom bar:** its height is measured before overlays are hidden for the screenshot.
- **Widget page:** a scan applies nothing. Each scanned value shows "From the scan" with its own Apply, and there's an Apply all. **Confirm brand** records who checked the name, avatar (at real size, on the header color) and primary color.
- **Scan corpus (2026-10-30):** 9 sites, 27 values (logo, name, primary): 23 right, 4 flagged "Check this", 0 wrong. Every preselected logo is the site's own. The flagged ones are progress.com's primary (a single button) and the names of whatsupgold.com, kemptechnologies.com and chef.io.

**Landed 2026-10-30, after the release check:**
- **Avatar:** the scan measures icon sizes (and tries `/favicon.ico`). The preselected avatar is the option that reads at 28 px: a header logo no wider than 2:1, else the home-screen icon, else a tab icon of 32 px or more. A wide wordmark is offered, marked hard to read, and preselected only when nothing else exists.
- **Contact page:** found from header, nav and footer links (contact words in about 20 languages), preferring the page's own section's. Handoff offers it first.
- **Name:** "Name visitors see" goes ahead of the scan's name.
- **Confirm brand** shows the widget's own header in each served language, at the layout's narrowest width.
- **Previews** draw the scanned bottom bar as a labelled band.
- **CSP:** the advice gives `img-src data:` for inline logos (never "null"). Check installation checks img-src and counts one cause once.
- **Corpus:** 4 of the 9 pages rechecked live, each now preselecting the site's own square mark. The other 5 weren't reloaded.

## 8. Fleet & cost dashboard

- **Fleet table:** customer, deployment, status, last sync, resources, asks (7d/30d), cost month-to-date vs budget, quality trend, open alerts.
- **Cost model:** the partner enters contract rates once. The worker rolls up two sources per KB:
  - **Query cost**, from `nuclia_tokens` on each question-log entry. This needs only the KB's manager key.
  - **Processing and storage**, from `usage?knowledgebox=` daily. This needs a PAT; without one, the dashboard shows query cost only.

  It then computes cost per tenant. An optional markup gives the client price; export is CSV for invoicing.
- **Built so far (2026-10-28):**
  - Fleet, customer, costs and settings pages over the worker's daily rollups.
  - Budget state per customer (within budget, on track to exceed, near at 80%, over), with the month projected from the last 7 days' pace.
  - Alerts for failed provisioning, failed or stale syncs, and a week-on-week drop of 0.4 or more in answer relevance.
  - Not yet: alert delivery by email or webhook, the hard stop, top questions and content gaps, and processing and storage costs.
- **Budgets:**
  - Per-tenant monthly cap, with email/Teams/Slack webhook alerts at 80% and 100%.
  - Optional hard stop: the console stops minting tokens for that deployment, so the widget shows a configurable offline message. Nothing is deleted.
- **Insights per tenant:**
  - Top questions.
  - Unanswered questions as **content gaps**, and thumbs-down answers as a separate **Rated not helpful** list. This is a natural upsell for agencies that sell content work.
  - Sync job failures.

**Landed 2026-10-30, after the second persona review: one definition of "answered", and validation that tests what visitors ask:**
- **One rule:** `verdict()` in `@launchpad/theme`. A reply is no answer when Agentic RAG reports `no_context` or `no_retrieval_data`, or its best reranked paragraph scores under 0.02. The widget, validation and GA all use it.
- **The widget's verdict is the record:**
  - It sends `question_hash` (a 64-bit hash of the normalized question) with `arag_chat_answer` and `arag_chat_feedback` to `/events` only. The route stores `answer_events`, with thumbs on the same row.
  - The worker pairs question-log rows with those events by hash, within 2 minutes before to 10 minutes after, nearest first. Unmatched rows get the same rule applied to the log's `status` and `resources_count`.
  - The log has no relevance score, so the 0.02 cutoff applies only through the widget. `asked_questions.verdictSource` records which source decided.
- **Validation:**
  - 4 questions generated from visitor-task pages, skipping legal, privacy, cookie, accessibility and thank-you pages, plus at least 2 the partner types. It never falls back to "What can you tell me about…".
  - A leak check in every served language fails answers that talk about "the context".
  - Prices, dates and overview-only sources are flagged for a named person to acknowledge.
  - It passes at 75% answered, with no failures and every flag acknowledged.
- **Starter questions:** chosen in a picker (intent-based suggestions plus passing validation questions, 60-character guide, chip preview). Nothing is saved until **Use these**.
- **Prompt templates:** they speak as the website, never mention context or documents, use the name visitors see, and end with today's date. The console adds the date on save, and the worker's hourly `prompt-date` job updates only that paragraph. (`/ask` also takes a per-request `extra_context`, unused: the widget asks with the saved configuration from the browser.)
- **Report:**
  - "Rated not helpful" sits next to Content gaps.
  - The wording now says "Identical wordings are counted together (ignoring case and punctuation)".
  - **Not a content gap** hides a question from the lists in the console and on share links; totals still count it.
  - "Figures to HH:MM UTC" shows the last roll-up. Months before the change say they were counted with the earlier rule.

**Landed 2026-10-30, after the release check: answer language and page identity:**
- **User prompt:** the console adds a user prompt (`prompt.user`, with `{context}` and `{question}`) after the site's text. It sets the answer language (the question's, or the deployment's fixed one), keeps each product's advice to that product, and asks for Agentic RAG's no-answer sentence in English, word for word, so `no_context` still works. The sentence translated or reworded (en, de, es, fr, it, nl, pt) is still no answer to the widget, validation and the report (`saysNoContext()` in verdict.ts).
- **Page titles:** retrieval adds `hierarchy`, so each page's text carries its title. Telerik's Silverlight question had taken .NET MAUI advice from a Xamarin page 5 of 5 times; with this, 0 of 4.
- **Older configurations:** the hourly prompt-date job installs both on them, unless someone set a user prompt in the dashboard. It only touches deployments whose prompt the console saved.
- **Validation:**
  - Asks in the question's language first, then across all pages.
  - Fails an answer in the wrong language.
  - Asks 3 at a time (60 s per ask) and streams its progress.
  - Records the content state (`content.partial`) and how long the run took.
  - Links a flagged figure to the page that shows it.
- **Review:** a run with under half the pages answerable, early in the first sync, has to run again before sign-off. "What can you tell me about…" questions are never counted or offered as starters, and older runs are judged by these rules too.
- **Alerts** fire only for failed answers, not for flags waiting for a person.
- **Starter picker:** keeps its suggestions until asked for new ones, and previews with the widget's own drawing. The guide is 48 characters, measured at 390 px.

**Landed 2026-10-30, after the third persona review:**
- **Answer language:** `answerLanguage()` is "unknown" below about four words that point to one language (numbers, currency, units and short shared words like "per" count for none). An answer is Failed only when the reading is at least twice as strong as any other; otherwise it's Check this, and unknown gives no verdict and no alert. "Telerik DevCraft Complete costs $1,299 per developer, per year" no longer fails as Italian, and a 50-answer test set keeps it so.
- **Starters** are asked in every run (in every served language) and when chosen, and the picker shows each answer before it can be ticked. A starter with no answer fails.
- **Checking figures:**
  - Each flagged figure is shown beside the sentence or table row that states it in the synced text, matched by digits, price pages first, then cited pages.
  - A figure no synced page states needs the address where the person found it.
  - An answer citing a page the content rules flag (an old price or offer, over 2 years old, a conversion page) is flagged `stale-source` for a person to check.
- **No answer:** the site's pages that may answer it (searched across the whole sitemap), **Add these pages** (asked again by the worker once they're answerable), or "The site doesn't cover this" with a reason. Removing a question that had a problem needs a reason, and Review lists every such decision with name and reason (`reviewNotes()`).
- **Leaks and re-runs:** "the page" joins the leak check. The worker's `revalidate` job re-runs, once, a run made during the first sync, after the sync finishes.
- **One visitor question counts once:** log rows with the same question hash within 2 minutes of the first are one question, with the last attempt's verdict and every attempt's tokens (`asked_questions.attempts`). Costs shows "N retries"; the client report never does. The month is recounted nightly and when the worker starts. The marketer's report went from 23 questions and 52% answered to 16 and 75%.
- **Test traffic** (a staging domain or a loopback origin) shows as "Test traffic: N questions, not counted", with a switch on the console report and the share link. The report's title is "Name visitors see", else "The client". A lead sent from one is a test too: its subject starts "[Test, from a staging page]" and its JSON carries `test: true`.
- **Alerts:**
  - Subjects lead with the internal customer name.
  - They run every minute with two looks (measured at most 30 s) and skip partial-content runs.
  - They include keys at 60, 30 and 7 days, and one older-checks alert per customer.
  - Each visitor-facing change to a published deployment after sign-off posts who changed what, where.
  - A widget save audits only the fields that differ in what visitors get, with value hashes, so "Changed since sign-off" lists only what still differs.

**Landed 2026-10-30, after the fourth persona review:**
- **One verdict function** (`verdict()` in `packages/theme/src/verdict.ts`), run by the widget, validation, the starter picker and the worker's report roll-up on the same facts. It gains `declined`: a reply that says the site lacks the information (in the seven widget languages) and gives no concrete detail (no figure, date, steps, link, phone, email or address) is no answer, and its text is shown as written. "Pricing is by quote: request one" stays an answer.
- **Check this** (`answerChecks()`): "short" (under 8 words with nothing concrete, or a reply that only points to a contact, like "Contact Support.") or "off-source" (no cited source shares a content word with the question, the brand's words left out, skipped across languages). It counts toward the pass once someone clicks **I checked it**, in validation and in the picker; a check made in the picker carries into validation.
- **The template:** the default prompt's don't-know line asks for the console's no-answer sentence word for word, and a new line says when prices are by quote and points to the page to ask. Existing deployments get both through **Update the prompt**.
- **Intent questions:** every run asks price, contact and support, and buy and trial or demo where the site has a key page for them, worded from the key pages in the main language. They replace generated questions (5 intents leave 3), so a run still asks about 10 plus the starters. An intent, a starter or one of the partner's own questions with No answer or Check this keeps the run at "Not yet" until it's fixed, checked, or marked **The site doesn't cover this** with a reason. Generated questions keep the pass threshold, and a pass with an undecided No answer says so ("Passed: 1 question with No answer and no decision"), on Review too. Review says "Check this: price questions have no answer and no quote button" when both are true.
- **The half-the-pages run:** validation runs by itself once half the pages are answerable, and Review and Validate say when ("Runs again by itself at 98 of 195 pages answerable (now 83, about 3 min)"), with **Run it now**.
- **A failing starter leaves the chat:** after an automatic run on a signed-off deployment, a live starter with no answer is asked once more; if it fails again, it's taken out of the widget's starters in every language and audited as `deployment.starters.removed`. Review records it until someone picks again. A starter that turns into Check this stays, and opens. Price checks carry over when every figure in the new answer was checked against the same source line.
- **`heldAt`** (on the sign-off): set when the run after the first sync leaves nothing open, or when a person's later run resolves what it opened.
- **`CHECKS_VERSION` 3:** every deployment signed off before shows "Signed off under older checks" until it's brought up to date (§5) and signed off again.
- **The report:** declined replies count as unanswered and are listed under Content gaps, with the line "From [date], replies that said “contact us” without answering count as gaps" for the month the rule ships. The roll-up takes each question's origin from the question event (§6), else the answer event, so test traffic no longer depends on the beacon.
- **Alerts:** only for automatic runs. One per automatic run that opens something on a signed-off deployment, naming the client, and one per starter removed; the same open items on the same deployment post once an hour at most. Runs a person starts in the console post nothing.
- **Fleet** keeps the customer under "Customers needing attention" until what the automatic run opened is resolved and any removed starter is picked again.
- **The clock:** the deployment page shows "Signed off 13 min after starting" and "Held after the first sync: 19 min" (or "not yet"); Fleet shows the median of each.

**Landed 2026-10-31, after the fifth persona review:**
- **Replies are judged by what they claim:** a negative claim ("does not list", "no … is listed", "has passed", in en, de, es and fr, `negativeClaim()`) about the thing asked, with nothing grounded of the kind asked for, is `may-not-answer`: no answer in the widget, GA and the report, Check this in validation and the picker. With grounded content of that kind it's `partly`, which counts as answered.
- **Grounding beats the relevance score:** a reply whose concrete content stands on the passages it cites (`grounded()`) is answered whatever its reranker score; the score only decides replies with nothing grounded.
- **The nightly roll-up** asks the judge (§5) about logged answers the verdict counts as answered but that make a negative claim, at most 200 a deployment a night, so content gaps are real.
- **An upgrade never sets the held time** (`heldAt`), so Fleet's onboarding medians leave upgrades out.
- **Fleet:** a "Signed off under older checks" tile and filter, oldest first, with **Read the pages again for all, tonight** (`queueReread`); and an "On older answering rules" tile for chats a re-check held or hasn't reached yet.
- **Suggested buttons:** the widget page offers ready-made buttons from the intent key pages and the buttons the scan found, filled in for each served language.

**Landed 2026-11-01, after the sixth persona review** (not yet seen live):
- **The price table check in validation, the picker and the re-run** (`priceTableCheck` in `validation-rules.ts`, on the confirmed table, §5).
  - **Before the judge:** it runs before the judge and doesn't depend on it.
  - **Holds:** each contradiction is a hold that names the pairing ("Standard is $4,500 on /pricing; this answer gives $6,200 for Standard"), with the page's line. I checked it isn't offered; the hold clears only by asking again, rewording, or a named reason.
  - **No check needed:** an answer whose every price is the table's, from the pricing page, has no price to check.
  - **Same code everywhere:** the starter picker and the overnight re-check (`recheckUnderLatestRules`) judge through the same `judgeAnswer`, with the same table.
- **The picker on validation's checks** (`starterNeed` in `validation-rules.ts`, imported, never copied).
  - **Price rows:** a price row the confirmed table agrees with needs no click.
  - **Checks that carry:** a row flagged for a price outside the table, or for a date, shows the figure lines and I checked it, and that check carries into validation.
  - **Kept replies:** a held reply that a named person keeps counts as answered for a starter.
  - **Refusals:** when Use these refuses a row, the error names the row and focus moves to its decision control. Ticks survive a failed save and a reload.
- **A scope-aware verdict** (`readReply` in `verdict.ts`), one function for the chat, the picker, validation and the re-check:
  - **Scope:** a negative claim counts only when its object (the negated clause, without the words that frame it) is what was asked. A reply opening with a plain yes or no, with content found on the pages it cites, is at least `partly`.
  - **`deflection`:** the reply's only way forward is a pointer.
    - **A contact question:** a page or form, with no contact detail, no way to talk to someone and no list of ways. It isn't a deflection when the cited contact page itself offers no phone or email.
    - **A price or date question:** every sentence only points somewhere.
    - **Never** for "where is…" questions.
  - **`substituted`:** the question asks for one of a trial or a demo, or one of a phone number or an email address, and the reply gives the other and nothing for the thing asked.
  - **A price question** answered with "prices are listed" and no figure may not answer.
  - **How they count:** deflections and substitutions are held in validation and the picker, where a named person can keep them, and are unanswered in the chat and the report.
  - **Tests:** `apps/console/test/verdict-paths.test.ts` runs the chat, picker, validation and re-check paths on the same text. It also scores the labelled development half (`apps/console/test/fixtures/verdict-labelled-dev.json`) against at most 5% of non-answers missed and 3% of answers held. A further test holds a mislabelled price on those paths with the judge off. The held-out half is for the release verifier.
- **Small fixes:**
  - **Review** lists answering-rules changes since sign-off ("answering rules v3 → v4, applied after a re-check", or "switched by" a named person; `rulesChangeLine`).
  - **The channel** gets one line when a signed-off chat's answering rules change. The account block and its all-clear post once each, and the overnight re-check records them too.
  - **Costs and the CSV** take test traffic (staging domains or partner staff) out of the customer price and show it in a Test traffic column (`lib/costs.ts`). The roll-up counts tokens per deployment and day, so each day's cost is split by its share of test questions in the question log.
  - **Handoff suggestions** put the contact key page first. The customer's primary contact comes last, labelled "only if the client wants visitors to email this person".
  - **Dashboard:** the cost tile names the month ("Cost in November"), or says the last 30 days on the 1st, and the projection says "at last 7 days' pace" (`lib/overview.ts`).
  - **History** has words for the price table's and the overnight job's entries (`lib/history.ts`).

## 9. Tenancy & access

| Role                            | Can                                                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Partner admin                   | Everything, including account credentials, contract rates, partner templates                                                                     |
| Partner member                  | Manage tenants and deployments; no credentials or rates                                                                                          |
| Customer viewer                 | Sign in by magic link; sees only their tenant's usage, top questions, quality and content gaps; no keys, no cost unless the partner shares price |
| Customer contributor (optional) | Invited to their own KB in the Agentic RAG dashboard via the KB invite API, for direct content management                                        |

Partner staff sign in with OIDC (Entra ID / Google, configurable), invited by an admin; the addresses in `LAUNCHPAD_ADMIN_EMAILS` become admins on first sign-in. **Landed 2026-10-30**, with Admin and Member roles (members see settings read-only and can't reveal keys). Customers get read-only share links to their report for now; email magic links (needs SMTP) come later.

## 10. Security

- PAT and KB keys encrypted with AES-256-GCM using a master key from env. They never reach the browser and are never logged.
- Public surface is only `/api/public/deployments/*`:
  - The token endpoint checks `Origin` against the deployment's domains, rate-limits per IP and deployment, and mints reader-scoped tokens with short TTLs.
  - KB `allowed_origins` is a second, independent lock. M0 showed it only stops browsers; scripted clients can send any `Origin`. So rate limits and budgets are the real abuse controls.
  - Ephemeral tokens travel in the `/ask` URL, so never log full request URLs.
- Writer and reader keys are separated per KB. An audit log covers every provisioning and key action. Keys can't be replaced from the console yet: each lasts a year, and an alert goes out before it expires.
- The sniffer only fetches URLs that partner users enter, blocks private IP ranges (SSRF), and enforces time and page limits.

## 11. Milestones

|              | Scope                                                                                                                                                                                            | Exit criteria                                                                                                                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **M0** spike | Script against a real enterprise account: credential model, KB + service account creation, ephemeral token → `/ask` from a browser origin, sitemap sync on a Sitefinity site, usage metric names | **Mostly done 2026-10-27** (§4a). Left: sitemap sync on a small site, PAT usage metrics, KB invites                                                                                                                |
| **M1**       | Monorepo, `par-client`, DB, auth, tenants/deployments, provisioning wizard through hand-off values                                                                                               | New KB fully provisioned for a real Sitefinity 15.4 site from the UI. **Scaffold landed 2026-10-27** (§3a). Provisioning forms landed 2026-10-29 (§5). Left: OIDC sign-in, detection, content sync, hand-off sheet |
| **M2**       | `<arag-chat>` + public config/token endpoints + embed snippet                                                                                                                                    | Widget answering on a 14.x site and a non-Sitefinity site. **Widget already answers end to end** against the spike KB in a browser (§3a)                                                                           |
| **M3**       | Sniffer + theme editor                                                                                                                                                                           | On 10 sample partner sites, ≥ 8 need no more than 3 token tweaks. **Widget page landed 2026-10-30** (§7): scan, theme and settings, live preview. Left: the 10-site trial                                          |
| **M4**       | Worker, usage rollups, cost model, budgets, fleet dashboard                                                                                                                                      | Cost per tenant reconciles with the account usage total. **Dashboard pages landed 2026-10-28** on demo data (§8). Left: worker on real KBs, alert delivery, PAT costs                                              |
| **M5**       | Customer viewer, client report, content-gap insights                                                                                                                                             | A customer can sign in and see only their data                                                                                                                                                                     |
| **M6**       | Hardening, docs, partner guide, Docker release, OSS launch                                                                                                                                       | `docker compose up` to first deployment in under 30 minutes on a clean machine                                                                                                                                     |

## 12. Open questions

1. **Credentials:** _resolved in M0._ A NUA key provisions everything, KB keys read analytics, and a PAT is only needed for account limits and processing/storage usage. Still open: whether partners will get a PAT under the contract.
2. **Contract terms:** which usage metrics the partner contract prices, how a Nuclia token maps to price, and whether `max_kbs` is raised for partner accounts. The M0 account already holds 25 KBs.
3. **Sitemap scope:** does `file_filter.glob_patterns` on a sitemap sync config limit which URLs get crawled? If not, the console has to pre-filter sitemaps itself and host a trimmed copy.
4. **Sitefinity automation:** can the _Agentic RAG connection_ be set via Sitefinity's API or MCP server? That would remove the last manual copy step for 15.4+.
5. **License and name:** Apache-2.0 is the suggested default; check the Progress OSS approval process. The name "Agentic RAG Launchpad" is a placeholder.
6. **Brand:** the console UI follows Progress Agentic RAG brand tokens (Arial fallback; Progress Sans files must not be bundled in the public repo). The widget is white-label by default, with an optional "Powered by Progress Agentic RAG" line.
