# Deadlock — Standard Wins Tracker

A single-page web app (Lightning Web Components on [LWR](https://lwr.dev)) that
tracks a player's progress toward Deadlock ranked eligibility:
**60 total Standard wins + 3 heroes with 15+ Standard wins each**.

Pure client-side: hero stats are aggregated from the player's full match
history via [api.deadlock-api.com](https://api.deadlock-api.com/v1). No
backend, no API keys, no env vars.

## Requirements

- Node >= 22
- npm (not yarn)

## Commands

| Command           | What it does                                  |
| ----------------- | --------------------------------------------- |
| `npm install`     | Install dependencies                          |
| `npm run dev`     | Dev server at http://localhost:3000           |
| `npm run build`   | Static build into `site/`                     |
| `npm run start`   | Serve the built site on port 3000             |
| `npm run stage`   | Build + serve (preview the production build)  |
| `npm run clean`   | Remove `node_modules`, `__lwr_cache__`, `site` |

There are no test, lint, or typecheck scripts — verify changes with
`npm run build`.

## Data sources

- **Other players** — full match history from the public Deadlock API.
- **This machine's own account** (Steam account id `199434043`) — a local
  `match-history.json` served at `/data/` (see Deployment below), refreshed
  every 10 minutes by the companion Rust poller
  [`deadlock-gc-history`](../deadlock-gc-history) (talks to the Steam Game
  Coordinator directly), merged with the public API so older beta-era
  matches are still counted.
- The app follows the OS color scheme (`prefers-color-scheme`). Dark mode is
  implemented by overriding SLDS 2's global `--slds-g-*` design tokens in
  `src/layouts/main.html`.

## Deployment

Multi-stage Docker: `node:24-alpine` builds the site, `nginx:alpine` serves
`site/`. `docker-compose` maps host port **14224** → 80 and read-only-mounts
`/home/wtaylor/deadlock-lwc-data` (the poller's output) to
`/usr/share/nginx/html/data`.

`nginx/nginx.conf` encodes the caching contract (`/1/` bundles immutable,
`/data/` no-cache, SPA fallback to `index.html`) — preserve those rules when
editing.
