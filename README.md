# Agentic RAG Launchpad

_Working name._ An open-source console for agencies that run **Progress® Agentic RAG** chat agents for many customers. The goal: paste a customer's site URL, get a working chat on their staging site in under 30 minutes, styled to match the site, with every client's usage, cost and answer quality in one place.

Each partner runs their own instance against their own Agentic RAG account. Every customer site gets its own Knowledge Box (KB), its own keys, and its own domain lock.

> **Status: scaffold (M1 in progress).** The libraries and the chat widget work and are tested, including end to end against a real Agentic RAG KB. The provisioning wizard, theme editor and dashboards are next. See [docs/DESIGN.md](docs/DESIGN.md) for the plan and the API findings it rests on.

## What's here

| Path                                       | What it is                                                                                                                                                                 | State                                                                                   |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [packages/par-client](packages/par-client) | Typed, dependency-free client for the Agentic RAG account, zone and KB APIs: KB and key provisioning, ephemeral tokens, streaming answers, analytics                       | Every call shape verified against a real account in the M0 spike; unit-tested           |
| [packages/theme](packages/theme)           | Widget design tokens: defaults, sanitising (values end up in customers' pages), WCAG AA contrast repair, CSS variables                                                     | Unit-tested                                                                             |
| [packages/widget](packages/widget)         | `<arag-chat>`: a dependency-free web component with shadow DOM, `::part()` hooks, streaming answers, source links, follow-up questions, and a full-screen layout on phones | Tested end to end in a browser against a real KB                                        |
| [packages/db](packages/db)                 | Postgres schema (tenants, deployments, keys, usage, quality, users, audit) and AES-256-GCM key sealing                                                                     | Sealing unit-tested; first migration generated, not yet applied to a database           |
| [apps/console](apps/console)               | Next.js console: fleet view, health check, and the two public widget endpoints (config, session token)                                                                     | Origin and rate-limit rules unit-tested; not yet run against a database                 |
| [apps/worker](apps/worker)                 | pg-boss jobs: per-deployment usage, query cost and REMi quality rollups                                                                                                    | Date and pricing logic unit-tested                                                      |
| [apps/sniffer](apps/sniffer)               | Internal service that scans a customer site for platform (incl. Sitefinity), sitemap size and styles, and proposes a theme                                                 | URL safety (SSRF), detection and theme derivation unit-tested; browser scan not yet run |
| [spike](spike)                             | The M0 API spike and a widget dev page                                                                                                                                     | Findings in DESIGN.md §4a                                                               |

## Running it

Requirements: Node 22.18+ (24 recommended), Postgres 17, or Docker.

```bash
cp .env.example .env    # set PAR_NUA_KEY, LAUNCHPAD_MASTER_KEY, LAUNCHPAD_ADMIN_PASSWORD, SNIFFER_TOKEN
npm install
docker compose up --build
```

Then open http://localhost:3000.

For development without Docker, run Postgres yourself, then `npm run db:migrate` and `npm run dev`.

### Credentials

| Variable               | Needed for                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `PAR_NUA_KEY`          | **Required.** A NUA key with KB management. It creates every customer KB, its keys and its domain lock. Zone and account are read from it. |
| `PAR_PAT`              | Optional. A Personal Access Token adds account limits and processing/storage usage to cost reporting (the Account API rejects NUA keys).   |
| `LAUNCHPAD_MASTER_KEY` | Encrypts every stored KB key. 32 random bytes: `openssl rand -base64 32`.                                                                  |

### Embedding the chat on a customer site

```html
<script src="https://<your-console>/arag-chat.js" data-deployment="<deployment-id>" async></script>
```

Theme and copy load at runtime from the console, so restyling never needs a re-embed. The script works on any site, including Sitefinity 14.x and 15.x.

## Development

```bash
npm test             # Node's built-in runner, straight from TypeScript
npm run typecheck
npm run lint         # Biome
npm run build
```

Conventions:

- **Few dependencies.** The client, theme and widget packages have none at runtime. Tests use `node:test`, and the worker and sniffer run their TypeScript directly on Node with no build step. Each dependency is supply-chain surface for every partner who deploys this.
- **Erasable TypeScript only** (`erasableSyntaxOnly`): no enums, namespaces or parameter properties, so Node can run any file directly.
- **Imports carry `.ts` extensions.**

## Security model in brief

- KBs are private. Browsers get a reader-scoped token per chat session, valid for 15 minutes.
- Each KB is locked to the customer's domains through `allowed_origins`, and the console checks `Origin` itself as well.
- Keys are sealed at rest and bound to their deployment and role.
- The sniffer refuses private addresses at every hop, and runs on a network with no route to the database.

Details are in [docs/DESIGN.md](docs/DESIGN.md) §10.

## License

[Apache-2.0](LICENSE), pending Progress's open-source review.
