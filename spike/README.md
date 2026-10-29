# M0 spike

Throwaway scripts that check the API assumptions in [docs/DESIGN.md](../docs/DESIGN.md) §4 against a real Agentic RAG account before we build on them. No dependencies: Node 22.18+ runs the TypeScript directly. Results from the first run are in DESIGN.md §4a.

## Setup

1. Put credentials in `.env` at the repo root (see `.env.example`):
   - A **NUA key** with KB management covers every provisioning step. It's detected automatically even if it's pasted into `PAR_PAT`.
   - A **Personal Access Token** adds the account-limit and usage checks.
   - Optionally set `SPIKE_SITE_URL` to a small site you're allowed to crawl.
2. Run every step in order, or one at a time:

```bash
node spike/m0.ts all
```

| Step           | Checks                                                                                                   |
| -------------- | -------------------------------------------------------------------------------------------------------- |
| `whoami`       | PAT works on the Account API; account type, KB limits, zones                                             |
| `kb`           | PAT can create a KB on the zone API with `allowed_origins`                                               |
| `keys`         | Reader / writer / manager service accounts and keys via API                                              |
| `content`      | Writer key ingests three small text pages; time to PROCESSED                                             |
| `searchconfig` | A saved `ask` configuration with a custom system prompt                                                  |
| `ask`          | Reader key `/ask`, sync and streaming; reader can't write; `.dp.` vs `.rag.` host                        |
| `tokens`       | Temporal keys (10 s max): fresh, started late, expired; ephemeral tokens; CORS per origin                |
| `ephemeral`    | Ephemeral token TTLs, scope and expiry; whether expiry cuts a stream; `allowed_origins` propagation time |
| `sitemap`      | Sitefinity detection, server-side sitemap sync, job status and logs (capped by `SPIKE_MAX_PAGES`)        |
| `usage`        | Per-KB usage metric names, activity metrics, REMi scores, ask logs                                       |

Then the browser half, which runs the widget flow in a real browser on an allowed origin (`:4173`) and on a blocked one (`:4174`):

```bash
node spike/browser/server.ts
```

### Widget dev page

Runs the real `<arag-chat>` source in a browser without npm or a bundler: Node strips the TypeScript on the fly. It stands in for the console's public endpoints, minting real tokens for the spike KB. That KB's `allowed_origins` is `http://localhost:4173`, so that's the port it uses.

```bash
node spike/widget/server.ts
```

Open `http://localhost:4173/`. Links at the top switch the mode (`embedded`, `chat`, `popup`, `floating`), the finish (`flat`, `gloss`, `gradient`) and the theme (`brand`, `default`). The header's "Ask us" button opens the chat through `data-arag-chat-open`.

## Output

Everything lands in `spike/out/`, which git ignores:

- `findings.md`: one line per thing learned
- `calls.jsonl`: every request and response, secrets redacted
- `state.json`: ids
- `secrets.json`: keys, mode 600

## Cleanup

The spike leaves its KB in place for inspection. Delete it with:

```bash
node spike/m0.ts cleanup --yes
```
