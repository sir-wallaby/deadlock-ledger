# AGENTS.md

Deadlock ranked-performance dashboard: a single-page LWC (Lightning Web Components) app running on LWR (Lightning Web Runtime). Pure client-side, **single-account** (own account `Wallaby32`, id `199434043` — no player search, no persistence). Match data comes from own-account files published by a local Rust GC poller (`deadlock-gc-history`, served at `/data/`); the public API `https://api.deadlock-api.com/v1` (no auth, no env vars, no backend) remains the fallback and the source of the pre-2026 beta-era matches the GC no longer retains.

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
- Components live in `src/modules/c/<name>/<name>.{js,html,css}` (namespace `c/`): `app` (root), `heroStats` (all-time Standard summary — demoted from the old eligibility tracker), `rankedStats` (the ranked dashboard).
- `c/rankedStats` renders, for the player's newest ranked season: a rank card (badge icon + overlaid roman numeral, points bar, calib/shield/form chips), a hand-rolled SVG badge chart (calibration band, W/L dots, rank-boundary gridlines, `<title>` tooltips), a hero-MMR strip and a points bar (own account only, from the poller), a ranked hero table (W-L/win%/KDA, scored only), and a recent-5 ranked list.
- `lightning/*` imports resolve to the `lightning-base-components` npm module, registered in `lwr.config.json`.
- SLDS (`@salesforce-ux/design-system`) is served from `node_modules` at `/assets` via an lwr.config.json asset alias — do not copy or vendor SLDS files into `src/`.
- `src/assets/rank-icons/` holds the 11 user-provided rank badge `.webp` files (no baked-in numeral; the app overlays the roman numeral). LWR serves `src/assets` at `/public/assets` — reference them as `/public/assets/rank-icons/Rank_<Name>_Badge.webp` (see `rankIcon()` in `constants.js`). There is deliberately **no Obscurus icon** — badge 0 falls back to text.
- Shared client code is plain ESM in `src/services/` (`deadlockApi.js`, `heroes.js`, `outcomes.js`, `constants.js`). `heroes.js` is a self-contained local snapshot of the API's `/assets/heroes` (slimmed to id/name/hero_type/icon images) — self-contained because of the service-import rule below.

## Ranked data model

- Ranked = `game_mode === 1 && match_mode === 4` (Standard + Ranked). `constants.js` is the display-side source of truth: `SEASONS` (S1 2026-07-30 → 2026-11-05T20:00Z — an hour early; S2 open-ended, `end` display-only), `seasonIndexFor`, `CALIBRATION_MATCHES` (8), `RANK_NAMES` (1 Initiate … 11 Eternus), `decodeBadge`, `rankIcon`.
- **Badge encoding (verified against live data):** `badge = rank×10 + subrank`, subrank 1..6 (I..VI). Badge 0 = Obscurus (calibration/unrated).
- The 5 ranked row fields (`ranked_display_badge`, `ranked_delta`, `ranked_calibration_match` (per-season 1..8; 0 = real match), `ranked_used_demotion_protection`, `low_pri_pool`) have identical names in the GC output and the API.
- **Season scoping:** `getPlayerHeroStats` returns `rankedMatches` = the ranked rows of the **newest season in which the player actually played ranked** (an S1-only player sees their S1 run, not an empty S2), newest first. `c/rankedStats` and the header's season line key off this.
- **Own-account data** (account id `199434043`, poller files at `/data/`): `match-history.json` (all matches — see Gotchas), `rank-data.json` (SO cache + GetRankData; the app consumes only `progress`/`max_progress` for the points bar), `hero-mmr.json` (per-hero `relative_mmr`; `-10` = unplayed, the MMR strip shows heroes with `relative_mmr > -10`). `getLocalRankedData(accountId)` returns `{rank, heroMmr}` for the local account and `null` otherwise (the app is pinned to the local account, so this is effectively always the former; the guard stays for the dev/API-fallback path).

## Conventions

- Component → component imports use `c/<name>`; imports of `src/services/` files from a component use a relative path (e.g. `../../../../services/deadlockApi.js`), since services are not LWC modules.
- Services must **not import each other** with relative paths — LWR's bundler mis-resolves them (rebased onto the importing component's dir, e.g. `src/modules/c/app/services/…`). Share logic by passing functions/values from the component (see `getPlayerHeroStats(accountId, {isScored, isWon})` + `src/services/outcomes.js`). Season constants are deliberately **duplicated** in `deadlockApi.js` (`SEASON_STARTS`) and `constants.js` (`SEASONS`) for this reason — keep them in sync.
- **LWC template constraints (learned the hard way):** no mixing static text and expressions in one attribute value; no bare literals in expressions (`{14}` → LWC1060); no spaces inside attribute expressions (`{g.y + 3}` → LWC1125); the root `<template>` cannot carry `if:true` (LWC1080) — wrap in an outer plain `<template>`. Compose all such values in JS getters.
- `bootstrap.syntheticShadow: true` in `lwr.config.json` is load-bearing for SLDS styling — don't remove it.
- New routes or asset aliases are declared in `lwr.config.json`, not in code.
- Theming: the app follows `prefers-color-scheme`. Dark mode works by overriding SLDS 2's global `--slds-g-*` tokens in `src/layouts/main.html` — new component CSS must use the `--lwc-*` theme variables (defined there), never hardcoded hex colors. Available: `--lwc-colorText/TextWeak/Background/BackgroundSecondary/Border/Track/Positive/Negative`. Exception: the rank-card numeral overlay is a fixed bright color + dark text-shadow on purpose — the badge is a fixed-color image identical in light/dark, so the overlay can't follow theme vars.

## Generated output — never hand-edit

- `site/` — LWR static build (index.html, content-hashed bundles under `site/1/`, generated `_redirects`/`serve.json`). All components inline into the single app bundle. Regenerate with `npm run build`.
- `__lwr_cache__/` — LWR compile cache; safe to delete.

## Deployment

- Multi-stage Docker: `node:24-alpine` builds the site, `nginx:alpine` serves `site/`; `docker-compose` maps host port 14224 → 80 and read-only-mounts the poller's data dir (`/home/wtaylor/deadlock-lwc-data`) to `/usr/share/nginx/html/data`.
- `nginx/nginx.conf` encodes the caching contract: `/1/` bundles immutable (1y), `/assets/` 7d, `index.html` no-cache, `/data/` no-cache, unknown paths fall back to `index.html` (SPA). Preserve these rules when editing.
- Deploy by syncing changed `src/` files to `wtaylor-deb:~/Repo/deadlock-lwc` (not a git repo — rsync them) and running `docker compose up -d --build` there.

## Gotchas

- `README.md` is leftover boilerplate (describes an `example/app` module and yarn). Trust `package.json` and `lwr.config.json` over it.
- In `src/services/deadlockApi.js`, only `game_mode === 1` (Standard) matches count, and stats are aggregated from full match history on purpose — the API's `/hero-stats` endpoint only covers ~30 days. Don't "simplify" back to it.
- Own-account match history (account id `199434043`) is served from `/data/match-history.json` — a host file refreshed out-of-band (every 10 min by the Rust poller) and mounted only in the Docker/nginx deployment. The poller `touch`es the remote file on every run even when content is unchanged, so the file mtime is a poller heartbeat and the staleness check in `deadlockApi.js` keys off it — don't "deduplicate" the touch away. Under `npm run dev` the `/data/` paths 404 and the app silently falls back to the public API (and to no points bar / MMR strip); that's expected, not a bug to fix.
- **The GC sets the ranked fields only in an interval-scoped call**: `game_mode=Normal` + `match_mode=Ranked` + `rank_interval=<n>` all set together (a plain call leaves every `has_*` false — live-verified Nov 17 2026). The poller fires that call for the current season (`RANK_INTERVAL` in its `src/main.rs`, bumped per season) and coalesces the fields from the previously stored file for older seasons, never clearing stored values. So local rows carry the badges (the poller's job); the API merge in `deadlockApi.js` no longer backfills them — it only patches unset `player_match_outcome` values and appends the API-only beta-era matches. Don't re-add a ranked backfill from the API.
- **The API is incomplete:** it lags and misses some matches (e.g. 4 of 11 S2 rows were GC-only, and some calibration rows are missing entirely — the calib count is the **max** known `ranked_calibration_match`, not a row count). Any UI keyed on badges must tolerate null rows: the chart carries badges forward (pre-first-known uses the first known, later unknowns use the last known) and renders unknowns as hollow dots; the rank card scans newest → oldest for the first known badge, else shows "Unrated".
- The GC poller sends the **real** `player_match_outcome` enum (its vendored protos were updated to the current game dump) but leaves it unset (0) for some matches (e.g. beta-era ones). The app therefore (a) patches the API's non-zero outcome onto overlapping rows whose outcome is unset during the merge in `deadlockApi.js`, and (b) treats 0/0/0-KDA matches as not-scored (see `isMatchScored`). Don't "simplify" the merge back to first-come-wins.
- `rank-data.json` is flat JSON (top-level `progress`/`max_progress`/`rank`/…); `getLocalRankedData` wraps it as `{rank: <that object>, heroMmr}`, so component code reads `localRanked.rank.progress`. Don't "fix" the apparent double-naming.
- Hero name lookups: `src/services/heroes.js` is the truth — a local snapshot of the API's `/assets/heroes` (fetched 2026-11-17, slimmed to id/name/hero_type/icon images; e.g. 4=Lady Geist, 7=Wraith, 19=Shiv, 52=Mirage, 63=Mina). Re-fetch from the API and re-slim if Valve adds or changes heroes. The component always resolves names through `heroMap` — never hardcode names.
- `npm run build` never *executes* service modules — it only bundles them. A syntax/runtime error in one (e.g. a hand-generated data file) ships fine and dies as a white screen in the browser. After touching `src/services/`, sanity-check with `node -e "import('./src/services/<file>.js').then(m => console.log('ok'))"`; `hero_type` is a **string** (`mystic`, `brute`, …), a past generator emitted it unquoted.
- Local git repo (branch `main`), not yet pushed to GitHub. Plan: create an empty **private** repo `deadlock-lwc` on github.com, then `git remote add origin git@github.com:<user>/deadlock-lwc.git && git push -u origin main`.
