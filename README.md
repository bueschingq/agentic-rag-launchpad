# Agentic RAG Launchpad

_Working name._ An open-source console for agencies that run **Progress® Agentic RAG** chat agents for many customers. The goal: paste a customer's site URL, get a working chat on their staging site in under 30 minutes, styled to match the site, with every client's usage, cost and answer quality in one place.

Each partner runs their own instance against their own Agentic RAG account. Every customer site gets its own Knowledge Box (KB), its own keys, and its own domain lock.

> **Status: M1–M3 in progress.** A partner can take a new client from **Add customer** to a validated, on-brand chatbot in the console. The console provisions the Knowledge Box, syncs the site's pages, scans and themes the widget, generates and runs test questions, checks the domain lock, and hands the client's web team a Sitefinity-ready install guide. After launch it covers editing, pausing, budgets and alerts, named sign-in, a monthly client report, and lead capture. See [docs/ONBOARDING-PLAN.md](docs/ONBOARDING-PLAN.md) for the 30-minute plan and [docs/DESIGN.md](docs/DESIGN.md) for the design and the API findings it rests on.

## What's here

| Path                                       | What it is                                                                                                                                                                                                                                                                                     | State                                                                                                                          |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| [packages/par-client](packages/par-client) | Typed, dependency-free client for the Agentic RAG account, zone and KB APIs: KB and key provisioning, ephemeral tokens, streaming answers, analytics                                                                                                                                           | Every call shape verified against a real account in the M0 spike; unit-tested                                                  |
| [packages/theme](packages/theme)           | Widget design tokens: defaults, sanitising (values end up in customers' pages), WCAG AA contrast repair, CSS variables                                                                                                                                                                         | Unit-tested                                                                                                                    |
| [packages/widget](packages/widget)         | `<arag-chat>`: a dependency-free web component with shadow DOM, four display modes (embedded, chat, popup, floating), flat, gloss and gradient finishes, `::part()` hooks, streaming answers, source links, follow-up questions, and a full-screen layout on phones                            | Tested end to end in a browser against a real KB                                                                               |
| [packages/db](packages/db)                 | Postgres schema (tenants, deployments, keys, usage, quality, users, audit) and AES-256-GCM key sealing                                                                                                                                                                                         | Sealing unit-tested; first migration generated, not yet applied to a database                                                  |
| [apps/console](apps/console)               | Next.js console: fleet, customer, costs and settings pages, new-customer and new-deployment forms that provision a KB, a widget page per deployment (site scan, theme, handoff, buttons, analytics, live preview), a health check, and the two public widget endpoints (config, session token) | Runs in CI on Postgres with demo data; screenshots of every page attached to each run. Provisioning run against a real account |
| [apps/worker](apps/worker)                 | pg-boss jobs: per-deployment usage, query cost and REMi quality rollups                                                                                                                                                                                                                        | Date and pricing logic unit-tested                                                                                             |
| [apps/sniffer](apps/sniffer)               | Internal service that scans a customer site for platform (incl. Sitefinity), sitemap size and styles, and proposes a theme                                                                                                                                                                     | URL safety (SSRF), detection and theme derivation unit-tested; scans run on New deployment and from the widget page            |
| [spike](spike)                             | The M0 API spike and a widget dev page                                                                                                                                                                                                                                                         | Findings in DESIGN.md §4a                                                                                                      |

## Running it

Requirements: Node 22.18+ (24 recommended), Postgres 17, or Docker.

```bash
cp .env.example .env    # set PAR_NUA_KEY, LAUNCHPAD_MASTER_KEY, LAUNCHPAD_ADMIN_PASSWORD, SNIFFER_TOKEN
npm install
docker compose up --build
```

Then open http://localhost:3000.

For development without Docker, run Postgres yourself, then `npm run db:migrate` and `npm run dev`. To see the dashboard with made-up customers, run `npm run db:seed-demo` on an empty database first.

### Credentials

| Variable               | Needed for                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `PAR_NUA_KEY`          | **Required.** A NUA key with KB management. It creates every customer KB, its keys and its domain lock. Zone and account are read from it. |
| `PAR_PAT`              | Optional. A Personal Access Token adds account limits and processing/storage usage to cost reporting (the Account API rejects NUA keys).   |
| `LAUNCHPAD_MASTER_KEY` | Encrypts every stored KB key. 32 random bytes: `openssl rand -base64 32`.                                                                  |

### Sign-in

Without OIDC settings the console runs in **setup mode**: one shared password (`LAUNCHPAD_ADMIN_PASSWORD`, HTTP Basic) and nobody named in the audit log. A banner says so. To give each person their own sign-in:

1. Register the console with your identity provider as a web app, with the redirect URI `<PUBLIC_BASE_URL>/auth/callback`:
   - **Microsoft Entra ID:** App registrations › New registration, then add a client secret.
   - **Google:** an OAuth client ID of type "Web application".
2. Set the provider's details:
   - `OIDC_ISSUER`: `https://login.microsoftonline.com/<tenant id>/v2.0` or `https://accounts.google.com`
   - `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`
   - `LAUNCHPAD_ADMIN_EMAILS`: the first admins
3. Restart the console. Admins invite everyone else under Settings › Users, as Admin (rates, markup, keys, users, alerts) or Member (everything else). MFA comes from the identity provider.

Only the widget's routes (`/arag-chat.js`, `/api/public/*`) and share links (`/share/*`) need to be reachable from the internet. Put the console behind a reverse proxy that exposes just those paths, plus `/auth/*` and the console for your own staff.

### Alerts and leads

Settings › Alerts takes a webhook (Slack, Teams, or any automation) and email addresses. Email needs `SMTP_URL` (`smtp(s)://user:password@host:port`) and `SMTP_FROM`. Each deployment's Edit page says where its leads go. A lead carries the visitor's consent (the exact wording, its language and time), what opened the form, and the visit's source (UTM tags, referrer, landing page): see [docs/leads.md](docs/leads.md) for the payload, its JSON schema, and HubSpot and Salesforce mappings.

### Embedding the chat on a customer site

```html
<script src="https://<your-console>/arag-chat.js" data-deployment="<deployment-id>" async></script>
```

Theme and copy load at runtime from the console, so restyling never needs a re-embed. The script works on any site, including Sitefinity 14.x and 15.x. Each deployment has an **install guide** (Sitefinity MVC page template and ASP.NET Core renderer, Google Tag Manager, CSP entries), shareable with the client's web team, and **Check installation** to confirm it.

## Development

```bash
npm test             # Node's built-in runner, straight from TypeScript
npm run typecheck
npm run lint         # Biome
npm run build
```

CI's `preview` job also runs the console against Postgres with the demo seed and attaches screenshots of every page to the run (`console-preview`).

Conventions:

- **Few dependencies.** The client, theme and widget packages have none at runtime. Tests use `node:test`, and the worker and sniffer run their TypeScript directly on Node with no build step. Each dependency is supply-chain surface for every partner who deploys this.
- **Erasable TypeScript only** (`erasableSyntaxOnly`): no enums, namespaces or parameter properties, so Node can run any file directly.
- **Imports carry `.ts` extensions.**

## Security model in brief

- One console, one zone: a console works with one Agentic RAG account in one region, and every Knowledge Box it creates (and every visitor question) stays in that region. A partner serving clients in another region runs a second console.
- KBs are private. Browsers get a reader-scoped token per chat session, valid for 15 minutes.
- Each KB is locked to the customer's domains through `allowed_origins`, and the console checks `Origin` itself as well.
- Keys are sealed at rest and bound to their deployment and role.
- The sniffer refuses private addresses at every hop, and runs on a network with no route to the database.

Details are in [docs/DESIGN.md](docs/DESIGN.md) §10.

## License

[Apache-2.0](LICENSE), pending Progress's open-source review.
