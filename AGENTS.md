# AGENTS.md

Deadlock ranked-eligibility tracker: a single-page LWC (Lightning Web Components) app running on LWR (Lightning Web Runtime). Pure client-side — fetches match data from `https://api.deadlock-api.com/v1` (no auth, no env vars, no backend).

## Commands

- **npm, not yarn** — README's `yarn` instructions are stale boilerplate. Use `npm ci` / `npm install`.
- `npm run dev` — dev server at http://localhost:3000
- `npm run build` — static build into `site/` (`lwr build --clean`)
- `npm run start` — serve the built static site on port 3000
- `npm run stage` — `build` + `start` (preview the production build locally)
- `npm run clean` — removes `node_modules`, `__lwr_cache__`, `site`
- There are **no test, lint, or typecheck scripts**. Don't invent them; verify by `npm run build`.
- Requires Node >= 22.

## Architecture

- Single root component `c/app` (`src/modules/c/app/`), rendered through `src/layouts/main.html` (LWR layout: `{{{body}}}` / `{{{lwr_resources}}}` placeholders). Route, layout, and bootstrap config live in `lwr.config.json`.
- Components live in `src/modules/c/<name>/<name>.{js,html,css}` (namespace `c/`): `app` (root), `playerSearch`, `heroStats`.
- `lightning/*` imports resolve to the `lightning-base-components` npm module, registered in `lwr.config.json`.
- SLDS (`@salesforce-ux/design-system`) is served from `node_modules` at `/assets` via an lwr.config.json asset alias — do not copy or vendor SLDS files into `src/`.
- Shared client code is plain ESM in `src/services/` (`deadlockApi.js`, `steam.js`).

## Conventions

- Component → component imports use `c/<name>`; imports of `src/services/` files from a component use a relative path (e.g. `../../../../services/deadlockApi.js`), since services are not LWC modules.
- Services must **not import each other** with relative paths — LWR's bundler mis-resolves them (rebased onto the importing component's dir, e.g. `src/modules/c/app/services/…`). Share logic by passing functions/values from the component (see `getPlayerHeroStats(accountId, isScored)` + `src/services/outcomes.js`).
- `bootstrap.syntheticShadow: true` in `lwr.config.json` is load-bearing for SLDS styling — don't remove it.
- New routes or asset aliases are declared in `lwr.config.json`, not in code.
- Theming: the app follows `prefers-color-scheme`. Dark mode works by overriding SLDS 2's global `--slds-g-*` tokens in `src/layouts/main.html` — new component CSS must use the `--lwc-*` theme variables (defined there), never hardcoded hex colors.

## Generated output — never hand-edit

- `site/` — LWR static build (index.html, content-hashed bundles under `site/1/`, generated `_redirects`/`serve.json`). Regenerate with `npm run build`.
- `__lwr_cache__/` — LWR compile cache; safe to delete.

## Deployment

- Multi-stage Docker: `node:24-alpine` builds the site, `nginx:alpine` serves `site/`; `docker-compose` maps host port 14224 → 80 and read-only-mounts host match history (`/home/wtaylor/deadlock-lwc-data`) to `/usr/share/nginx/html/data`.
- `nginx/nginx.conf` encodes the caching contract: `/1/` bundles immutable (1y), `/assets/` 7d, `index.html` no-cache, `/data/` no-cache, unknown paths fall back to `index.html` (SPA). Preserve these rules when editing.

## Gotchas

- `README.md` is leftover boilerplate (describes an `example/app` module and yarn). Trust `package.json` and `lwr.config.json` over it.
- In `src/services/deadlockApi.js`, only `game_mode === 1` (Standard) matches count, and stats are aggregated from full match history on purpose — the API's `/hero-stats` endpoint only covers ~30 days. Don't "simplify" back to it.
- Own-account match history (account id `199434043`) is served from `/data/match-history.json` — a host file refreshed out-of-band (every 10 min by a separate Rust poller) and mounted only in the Docker/nginx deployment. The poller `touch`es the remote file on every run even when content is unchanged, so the file mtime is a poller heartbeat and the staleness check in `deadlockApi.js` keys off it — don't "deduplicate" the touch away. Under `npm run dev` that path 404s and the app silently falls back to the public API; that's expected, not a bug to fix.
- The GC poller only **synthesizes** `player_match_outcome` as 1 (win) / 2 (loss) — its vendored protos predate the real enum. The app therefore (a) patches the API's real outcome (3/4/5) onto overlapping rows during the merge in `deadlockApi.js`, and (b) treats 0/0/0-KDA matches as not-scored (see `isMatchScored`). Don't "simplify" the merge back to first-come-wins.
- Local git repo (branch `main`), not yet pushed to GitHub. Plan: create an empty **private** repo `deadlock-lwc` on github.com, then `git remote add origin git@github.com:<user>/deadlock-lwc.git && git push -u origin main`.
