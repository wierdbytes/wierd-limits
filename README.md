# wierd-limits

Subscription limits (Claude, Codex, Qwen) in Herdr, live from pi.

- **pi** — [`pi-langfuse` fork](https://github.com/wierdbytes/pi-langfuse/tree/feat/rate-limit-scores)
  writes every usage window a provider reports (Anthropic `anthropic-ratelimit-unified-*` headers,
  Codex `codex.rate_limits` / `x-codex-*`) as a Langfuse score `rl.<provider>.<account>.<window>`.
- **Langfuse** keeps them: current values via `GET /api/public/v3/scores`, charts via
  `GET /api/public/v2/metrics`.
- **Herdr** — the `limits` mod in `herdr-mod/` reads them with pi-langfuse's keys, adds what
  `~/bin/ai-usage` polls (plan, per-model weekly limits, extra spend, credits, Qwen) and shows
  one row per account in the status bar and sidebar, with charts on click.

How it works: [docs/architecture.md](docs/architecture.md) (Russian).

## Setup

1. pi-langfuse from the fork, rate-limit scores on:

   ```sh
   git clone -b feat/rate-limit-scores https://github.com/wierdbytes/pi-langfuse ../pi-langfuse && cd ../pi-langfuse && git checkout feat/rate-limit-scores && npm ci
   # ~/.pi/agent/settings.json: "packages": [..., "/path/to/pi-langfuse", ...] instead of "npm:pi-langfuse"
   # ~/.pi/agent/pi-langfuse/config.json:
   #   "capture": { "PI_LANGFUSE_RATE_LIMIT_SCORES": "true" }
   ```

   Restart pi sessions (or `/reload`) to pick it up.

2. The mod:

   ```sh
   scripts/install-mod.sh     # copies herdr-mod/ to ~/.config/herdr-app/mods/limits and checks it
   ```

   Keys come from `~/.pi/agent/pi-langfuse/config.json`; a `mods/limits/langfuse.json` with
   `{ "host", "publicKey", "secretKey" }` overrides them.

## Using it

- Status bar: click a provider for its charts, right-click for settings.
- Sidebar: click a row to open it; the chart icon on an open row opens its charts; click a limit to
  pin it as the row's headline.
- Keys (`keys.json`): `limits.refresh`, `limits.menu`, `limits.chart` (the focused agent's provider).
- Charts: **Window** — the current window as a stepped area, the even-pace diagonal and a tick at
  now; **History** — the highest reading per bucket over the last 7 days (5h) or 28 days (7d).

## Development

```sh
bun test                     # reduce.js and langfuse.js (pure, no Herdr)
herdr-app check herdr-mod    # loads and renders the mod once
```
