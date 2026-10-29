# Agentic RAG Launchpad — v1 design

_Working name. An open-source, self-hosted console that lets a Sitefinity partner agency run Progress® Agentic RAG chat agents for many customers, the way a managed service provider would._

Status: draft for review · 2026-10-26 · M0 spike results folded in 2026-10-27 (§4a)

---

## 1. Why this exists

ai12z sells into the same Sitefinity accounts that Progress Agentic RAG now serves natively. Its pitch to agencies is simple: paste a site URL, get a branded agent, embed it, and manage all clients from one portal. Agentic RAG already has most of the building blocks: a Sitefinity 15.4+ connector, an AI Assistant widget, and a full account/zone API. What it lacks is a **partner-facing workflow**. Today a partner has to:

1. Create a KB in the dashboard, pick models, and mint a Writer key.
2. Write a prompt and search configuration by hand.
3. Copy the endpoint, UID and key into Sitefinity's _Administration » Agentic RAG connection_.
4. Accept a widget that comes in four styles and doesn't blend into the customer's site.
5. Repeat all of this per client, with no cross-client view of usage, cost or quality.

**Target:** site URL in → themed, working chat on the customer's staging site in **under 30 minutes and under 10 clicks**, with every client visible in one dashboard.

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
- the widget bundle: 7.7 KB gzipped, against a 40 KB budget
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

| Need                             | Endpoint                                                                                                               | Credential                  | M0                       |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------ |
| Resolve account from key         | `GET {zone}/api/authorizer/info` → `account_id`, `account_type`                                                        | NUA key                     | ✅                       |
| Account limits (max KBs, quotas) | `GET /account/{id}` → `max_kbs`, `limits.usage.*`                                                                      | PAT only (NUA key → 403)    | ⏳ needs PAT             |
| Create / modify / delete KB      | `POST /account/{id}/kbs` (slug, title, `allowed_origins`, `search_configs`, …), `PATCH`/`DELETE /account/{id}/kb/{kb}` | NUA key or PAT              | ✅ 1.7 s                 |
| Per-KB API keys                  | `POST /account/{id}/kb/{kb}/service_accounts` (role) + `/service_account/{sa}/keys` (`expires`)                        | NUA key or PAT              | ✅                       |
| Browser token                    | `POST /ephemeral_token` `{ttl}`, sent as `?eph-token=`                                                                 | reader key                  | ✅                       |
| Saved prompt/RAG config          | `POST /kb/{kb}/search_configurations/{name}` `{kind:"ask", config}`; `/ask` takes `search_configuration`               | manager key                 | ✅                       |
| Ingest                           | `POST /kb/{kb}/resources` (text, link, file; `origin.url` for citations)                                               | writer key                  | ✅~6 s to PROCESSED      |
| Server-side crawl                | `POST /kb/{kb}/external_connections` (`provider: "sitemap"`) + `/sync_configs` + `/sync_config/{id}/sync`, `/jobs`     | manager key or PAT          | ⏳ not run (§4a)         |
| Usage per tenant                 | `GET /account/{id}/usage?knowledgebox={kb}&aggregation=day&from=…`                                                     | PAT only (NUA key → 403)    | ⏳ needs PAT             |
| Volume                           | `GET /kb/{kb}/activity/metrics` (search / ask / chat per hour)                                                         | manager key (NUA key → 403) | ✅ near real time        |
| Question log                     | `POST /kb/{kb}/activity/ask/query` (NDJSON: question, answer, `nuclia_tokens`, model, timings, feedback)               | manager key                 | ✅                       |
| Quality                          | `GET /kb/{kb}/remi/scores`, `POST /kb/{kb}/remi/query`                                                                 | manager key                 | ✅ scores within minutes |
| Customer KB access               | `PATCH /account/{id}/kb/{kb}/users`, `POST …/invite` (`SOWNER`, `SMEMBER`, `SCONTRIBUTOR`)                             | NUA key or PAT              | not run                  |
| Backups                          | `/account/{id}/backups`, `/restore`                                                                                    | —                           | not run                  |

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

- A plain custom element (no framework) in shadow DOM, bundled by esbuild into one classic script, so `document.currentScript` works in the embed snippet. Budget **≤ 40 KB gzipped**, enforced by the build.
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
  - Per-tenant monthly cap, with email/Teams/Slack webhook alerts at 50 / 80 / 100%.
  - Optional hard stop: the console stops minting tokens for that deployment, so the widget shows a configurable offline message. Nothing is deleted.
- **Insights per tenant:**
  - Top questions.
  - Low-REMi and thumbs-down answers, grouped as **content gaps**. This is a natural upsell for agencies that sell content work.
  - Sync job failures.

## 9. Tenancy & access

| Role                            | Can                                                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Partner admin                   | Everything, including account credentials, contract rates, partner templates                                                                     |
| Partner member                  | Manage tenants and deployments; no credentials or rates                                                                                          |
| Customer viewer                 | Sign in by magic link; sees only their tenant's usage, top questions, quality and content gaps; no keys, no cost unless the partner shares price |
| Customer contributor (optional) | Invited to their own KB in the Agentic RAG dashboard via the KB invite API, for direct content management                                        |

Partner staff sign in with OIDC (Entra ID / Google, configurable). Customers use email magic links (needs SMTP).

## 10. Security

- PAT and KB keys encrypted with AES-256-GCM using a master key from env. They never reach the browser and are never logged.
- Public surface is only `/api/public/deployments/*`:
  - The token endpoint checks `Origin` against the deployment's domains, rate-limits per IP and deployment, and mints reader-scoped tokens with short TTLs.
  - KB `allowed_origins` is a second, independent lock. M0 showed it only stops browsers; scripted clients can send any `Origin`. So rate limits and budgets are the real abuse controls.
  - Ephemeral tokens travel in the `/ask` URL, so never log full request URLs.
- Writer and reader keys are separated per KB. One-click rotation and an audit log cover every provisioning and key action.
- The sniffer only fetches URLs that partner users enter, blocks private IP ranges (SSRF), and enforces time and page limits.

## 11. Milestones

|              | Scope                                                                                                                                                                                            | Exit criteria                                                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M0** spike | Script against a real enterprise account: credential model, KB + service account creation, ephemeral token → `/ask` from a browser origin, sitemap sync on a Sitefinity site, usage metric names | **Mostly done 2026-10-27** (§4a). Left: sitemap sync on a small site, PAT usage metrics, KB invites                                                                   |
| **M1**       | Monorepo, `par-client`, DB, auth, tenants/deployments, provisioning wizard through hand-off values                                                                                               | New KB fully provisioned for a real Sitefinity 15.4 site from the UI. **Scaffold landed 2026-10-27** (§3a). Left: OIDC sign-in, wizard                                |
| **M2**       | `<arag-chat>` + public config/token endpoints + embed snippet                                                                                                                                    | Widget answering on a 14.x site and a non-Sitefinity site. **Widget already answers end to end** against the spike KB in a browser (§3a)                              |
| **M3**       | Sniffer + theme editor                                                                                                                                                                           | On 10 sample partner sites, ≥ 8 need no more than 3 token tweaks                                                                                                      |
| **M4**       | Worker, usage rollups, cost model, budgets, fleet dashboard                                                                                                                                      | Cost per tenant reconciles with the account usage total. **Dashboard pages landed 2026-10-28** on demo data (§8). Left: worker on real KBs, alert delivery, PAT costs |
| **M5**       | Customer viewer, client report, content-gap insights                                                                                                                                             | A customer can sign in and see only their data                                                                                                                        |
| **M6**       | Hardening, docs, partner guide, Docker release, OSS launch                                                                                                                                       | `docker compose up` to first deployment in under 30 minutes on a clean machine                                                                                        |

## 12. Open questions

1. **Credentials:** _resolved in M0._ A NUA key provisions everything, KB keys read analytics, and a PAT is only needed for account limits and processing/storage usage. Still open: whether partners will get a PAT under the contract.
2. **Contract terms:** which usage metrics the partner contract prices, how a Nuclia token maps to price, and whether `max_kbs` is raised for partner accounts. The M0 account already holds 25 KBs.
3. **Sitemap scope:** does `file_filter.glob_patterns` on a sitemap sync config limit which URLs get crawled? If not, the console has to pre-filter sitemaps itself and host a trimmed copy.
4. **Sitefinity automation:** can the _Agentic RAG connection_ be set via Sitefinity's API or MCP server? That would remove the last manual copy step for 15.4+.
5. **License and name:** Apache-2.0 is the suggested default; check the Progress OSS approval process. The name "Agentic RAG Launchpad" is a placeholder.
6. **Brand:** the console UI follows Progress Agentic RAG brand tokens (Arial fallback; Progress Sans files must not be bundled in the public repo). The widget is white-label by default, with an optional "Powered by Progress Agentic RAG" line.
