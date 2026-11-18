# AGENTS.md

Single-binary Rust CLI (edition 2021). Fetches own-account Deadlock (Steam appid 1422450) match history directly from the Steam Game Coordinator (GC message 9112), bypassing third-party APIs. No tests, no CI, no lint config. Lives in the `deadlock-ledger` monorepo as the `gc-tap/` subtree (branch `main`); the frontend is the sibling `deadlock-lwc/` subtree. All app code is in `src/main.rs`.

## Build & run

```sh
cargo build --release
cargo clippy --all-targets   # keep at zero warnings (default lints)
./target/release/deadlock-gc-history status     # offline state check
./target/release/deadlock-gc-history check      # safe end-to-end verify (writes /dev/null)
./target/release/deadlock-gc-history fetch      # writes the data files (see State files)
```

## Commands (subcommands are hand-parsed, no clap)

- `login` — **interactive only** (password prompt, may request a Steam Guard code on the console). An agent cannot run it headless. If `fetch`/`check` fails with "no saved refresh token" or "refresh token expired", ask the user to run `login`.
- `fetch` — headless; needs a valid refresh token + network access to Steam. Optional `--out PATH`, `--interval N` (default `RANK_INTERVAL`).
- `check` — like `fetch` but discards output. Accepts `--interval N`. This is the right post-change verification step (besides `cargo check`).
- `status` — offline; shows config/token/data state.

## State files (XDG paths)

- config: `~/.config/deadlock-gc-history/config.json`
- refresh token: `~/.local/share/deadlock-gc-history/refresh_token` (mode 0600)
- data: `~/.local/share/deadlock-gc-history/` — `match-history.json` (all matches), `rank-data.json` (own-account ranked state: SO cache + GetRankData), `hero-mmr.json` (per-hero relative MMR from GetHeroMMRRankings). The latter two are written only when their source succeeded; both are skipped-if-unchanged (atomic tmp+rename).

## Vendored dependencies — read before touching Steam protocol code

- `vendor/steam-vent` is a **path dependency vendored in-repo** (not a git submodule). If Steam client behavior is wrong, edit it there.
- `vendor/steam-vent-proto-deadlock` is also **vendored in-repo** (path dependency). The codeberg git dep it was copied from is stale (predates the ranked season), so the 10 `citadel_*.proto` + `base_*.proto` files were swapped for current-game dumps from <https://github.com/SteamTracking/Protobufs> and the crate's `src/generated/` regenerated with `steam-vent-proto-build` (see the vendored crate's README for the exact procedure, incl. stripping the dumper-metadata options the parser rejects).
- `player_match_outcome` is now the GC's **real outcome enum** (0=invalid, 1=win, 2=loss, 3=penalized, 4=penalized party, 5=not-scored), mapped straight from the proto in `src/main.rs`. When the server leaves it unset (0 — e.g. beta-era matches) it falls back to 1/2 from the team comparison. This is what let the app's win counts match the in-game counter exactly (a penalized Lady Geist match the old proto hid as a win was the 1-match delta).

## Output contract

`match-history.json` is a JSON array mirroring `api.deadlock-api.com /v1/players/{id}/match-history` (fields in `MatchOut`, `src/main.rs`). Downstream consumer: the `deadlock-lwc` container. Preserve the shape when changing output.

The 5 ranked fields on `MatchOut` (`ranked_display_badge`, `ranked_delta`, `ranked_calibration_match`, `ranked_used_demotion_protection`, `low_pri_pool`) are `Option`s serialized as `null` when unset. **The GC gates them on `game_mode` + `match_mode` + `rank_interval` all being set** on the request (live-verified Nov 17 2026: a plain call leaves every `has_*` false; `game_mode=Normal` + `match_mode=Ranked` + `rank_interval=<n>` returns the whole interval's ranked history in one response, every row carrying the fields; `ranked_type` is irrelevant). `fetch_matches` fires that interval-scoped call after the main pages (best effort — a failure only costs the fresh fields), merges by `match_id` (the interval row wins — it is a field-wise superset), and coalesces the fields from the previously stored file (older intervals are never re-fetched; stored values are never cleared). `ranked_display_badge` is the POST-match badge. Don't drop the fields to "simplify" — the app keys badge UI off them.

## Ranked interval — season rollover

`RANK_INTERVAL` (src/main.rs) is the current season's `m_unInterval` from ranked_seasons.vdata (S1 = 1, S2 = 2) — **not** the SO's `CSORankedProgress.rank_interval` (a different GC-internal id space). When a season rolls over (S2 ends 2027-03-11 22:00Z): bump the constant, rebuild, redeploy, then run `fetch --interval <old season>` **once** — the default call no longer covers the ended interval, and the one-time fetch stores its ranked fields, which the coalesce then carries forward forever. `check` accepts `--interval N` too (verify without writing).

## Ranked state (S2) — SO cache + explicit round-trips

`fetch_matches` fires the interval-scoped match-history call (see Output contract) after the match pages, then runs three ranked-state lookups — all in **both `check` and `fetch` modes**:

1. **CSORankedProgress** ("Ranked Points" — the live rank state) via `fetch_ranked_progress`. The GC **auto-pushes the account's SO cache as a kind-24 `CMsgSOCacheSubscribed` right after the welcome, before any request**. That push wins the race against a late `on_kind` subscription and lands in the `MessageFilter`'s `rest` buffer, so the acquisition order is: welcome's `outofdate_subscribed_caches` → `gc.unprocessed()` (new pub method on the vendored `GameCoordinator`, delegates to `filter.unprocessed()`) → drain the pre-subscribed stream (2s settle) → `gc.unprocessed()` again → **fallback**: an active `CMsgSOCacheSubscribed` request for type ids 101..=150 with 3 owner variants (none / steam64 / account32 as `CMsgSOIDOwner`, 8s each). The GC ignores active requests when it has already pushed, so the fallback rarely runs.
2. **GetRankData** (9271) via `fetch_rank_data` — tolerant; returns `None` on failure.
3. **GetHeroMMRRankings** (9234) via `fetch_hero_mmr` — per-hero `relative_mmr` (`-10` = unplayed default), tolerant.

`rank-data.json` merges both: SO-cache fields (progress/max_progress/rank/…) plus GetRankData fields (`requires_calibration`, confidences, `last_match_*`); it is written if **either** source succeeded. Unknown SO fields are kept raw (see below) — the app currently consumes only `progress`/`max_progress`.

**Live-verified SO type ids** (kind-24 push): 104 = CSORankedProgress (1 object), 107 = per-hero MMR (41 objects), 7 and 112 = other account SOs.

**SO semantics are only partially understood — re-verify after the next ranked match** before adding UI: `last_match_*` (outcome=1, KDA 0/3/24, no hero) matches **no** match in the full history; `demote_protect_games` is a Unix timestamp (≈2026-09-11, stale-snapshot hint); `rank 19 / max_rank 2 / rank_interval 103 / win_bit_mask 0 / match_count 0` are unexplained; `rank_type 0` (enum only has Invalid/Normal). The per-match `player_rank_data` in match metadata (see next section) partially untangles the shield/delta question.

## GC message catalog + per-match metadata (investigated Nov 18 2026 — reference for frontend work)

**Catalog**: `EGCCitadelClientMessages` (`citadel_gcmessages_client.proto:7`) defines all 180 GC type IDs (9010–9312); we use 3. Key unused **read** endpoints:

| ID | Message | What it gives |
|---|---|---|
| 9167 | GetMatchMetaData | `{metadata_salt, replay_salt, replay_group_id, replay_valid_through}` — the key to per-match detail (below) |
| 9164 | GetAccountStats | per-hero opaque `stat_id`/`total_value[]` pairs + medal counts (`CMsgAccountHeroStats`, common:821) |
| 9024 | GetProfileCard | public card for any `account_id`: wins/kills/games, per-hero W/K, ranked badge |
| 9236 / 9238 / 9293 | GetLeaderboard / GetAccountLeaderboards / GetLeaderboardStatus | regional boards (EU/Asia/NA/SA/Oceania), per-hero, eligibility |
| 9311 / 9306 | CabalGetMatchHistory / CabalGetDetails | clan ("cabal") history + info |
| 9186 / 9195 / 9213 / 9199 / 9280 / 9242 | GetBook / FindHeroBuilds / GetFriendGameStatus / GetAccountMatchReports / HeroReleaseVote / Tarot | cosmetics, community builds, friends' status, reports received, votes |
| 9203 / 9291 / 9211 / 9172 / 9230–9233 | GetActiveMatches / dev + mod messages | live match list, dev/mod tools |

**Per-match detail pipeline** (verified live Nov 18, own account, zero public API):

```
GC 9167 {match_id} → {metadata_salt, replay_salt, replay_group_id, replay_valid_through}
HTTP GET http://replay{group}.valve.net/1422450/{match_id}_{metadata_salt}.meta.bz2   (no auth — the salt is the token)
sniff magic bytes → zstd (recent matches) or bzip2 (old) despite the .bz2 extension
→ CMsgMatchMetaData {version, match_details, match_id} → match_details = CMsgMatchMetaDataContents
```

- Our GC session returns the same `metadata_salt` the public API has, **plus** `replay_salt` (the API returned it null) — full `.dem.bz2` replays at `…/{match_id}_{replay_salt}.dem.bz2` are downloadable if ever needed.
- `replay_valid_through` is **not** a hard expiry: a beta-era file (valid_through 2026-05-06) still downloads today.
- The vendored protos decode files from both eras — schema stable across a year of game versions.
- Rate limit: `k_eResult_RateLimited` exists; the ecosystem caps ~40 salt fetches/account/day. We'd do 1–3/day — back off politely.
- Wiring it up needs new deps in `Cargo.toml`: `reqwest` (HTTP) + `zstd` + `bzip2` (there is no HTTP client today).

**`CMsgMatchMetaDataContents`** (common:539) — what each file holds (~40–230 KB compressed):

- **match**: duration, outcome, winning_team, `objectives[]` (destroy times + damage breakdown), mid_boss, pauses, pool flags, `ranked_type`/`rank_interval`, **`street_brawl_rounds[]`** (per-round duration + winner) + **`team_score[]`** (Brawl)
- **`damage_matrix`**: 13 dealers (slots 0–12), 15 cumulative samples @180 s, broken down by ~391 damage sources (abilities, weapon sets, bullets, items) — "who hurt me with what"
- **`match_paths`**: every player's movement sampled at 1 s with combat state
- **per player (all 12)**: KDA, net_worth, last_hits, denies, lane, level, hero, **`death_details[]`** (time, TTK, killer, positions), **`items[]`** (full buy history incl. upgrades/imbues/sells), **`stats[]`** time series (dmg dealt / **dmg taken**, healing, accuracy, gold breakdown), pings, `ability_stats[]`, **`mvp_rank`** (top-3 only), **`accolades[]`** (25+ stat IDs), rewards, **`player_rank_data`**

**Per-match rank data** (`CMsgMatchPlayerRankData`, common:528): `desired_progress_change` is the **raw MM delta pre-shield** (−350 both Nov 16/17); the history `ranked_delta` is the applied one (Nov 16: −150, shield absorbed 200, badge held at 26; Nov 17: −350, badge 26→25). Better source than the SO for shield/delta semantics — re-verify after the next ranked match before building rank UI off it.

**Brawl**: `game_mode` 4 = StreetBrawl (enum: 1 Normal, 2 1v1Test, 3 Sandbox, 4 StreetBrawl, 5 ExploreNYC, 6 Internal); `match_mode` 8 = NewPlayerPlacement. The 9112 `Match` message already carries `brawl_score_team0/1` + `brawl_avg_round_time_s` — `MatchOut` already maps them (they're in the JSON, unused by the UI); the frontend `gameModeLabel` already labels 4 "Street Brawl". The user's oldest match (75793262) is a brawl: 8p, `team_score [3,1]`, 4 rounds, full per-player stats present.

**Gotchas**: the `tracked_stats` arrays (player/team/match) are empty in normal ranked matches — teamfight % / CS score must be *computed* from `damage_matrix`/`stats`, not read off a flag. `average_badge_team0/1` = 0 in the user's ranked matches (untrusted).

## Deployment

`./push.sh` (repo root): runs the release binary's `fetch`, then pushes all three data files to host `wtaylor-deb` at `~/deadlock-lwc-data/` (which the `deadlock-lwc` container serves read-only at `/data/`), per file:

- **match-history.json** — heartbeat: if the sha256 is unchanged it `touch`es the remote file so the mtime still advances (the app judges local-data freshness by mtime — an idle stretch without new matches must not read as a dead poller). Changed content is pushed atomically (tmp+rename).
- **rank-data.json / hero-mmr.json** — skip-if-unchanged (no touch); absent locally (source fetch failed) → skipped.

All ssh is BatchMode (key auth must already work). Requires an up-to-date `target/release/deadlock-gc-history`; rebuild before running it.
