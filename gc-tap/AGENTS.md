# AGENTS.md

Single-binary Rust CLI (edition 2021). Fetches own-account Deadlock (Steam appid 1422450) match history directly from the Steam Game Coordinator (GC message 9112), bypassing third-party APIs. No tests, no CI, no lint config. Local git repo (branch `main`), not yet pushed — plan: create an empty **private** GitHub repo `deadlock-gc-history`, then `git remote add origin git@github.com:<user>/deadlock-gc-history.git && git push -u origin main`. All app code is in `src/main.rs`.

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
- `vendor/steam-vent-proto-deadlock` is also **vendored in-repo** (path dependency). The codeberg git dep it was copied from is stale (predates the ranked season), so the 10 `citadel_*.proto` + `base_*.proto` files were swapped for current-game dumps from <https://github.com/SteamTracking/Protobufs> and `src/generated/` regenerated with `steam-vent-proto-build` (see the vendored crate's README for the exact procedure, incl. stripping the dumper-metadata options the parser rejects).
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

**SO semantics are only partially understood — re-verify after the next ranked match** before adding UI: `last_match_*` (outcome=1, KDA 0/3/24, no hero) matches **no** match in the 233-match history; `demote_protect_games` is a Unix timestamp (≈2026-09-11, stale-snapshot hint); `rank 19 / max_rank 2 / rank_interval 103 / win_bit_mask 0 / match_count 0` are unexplained; `rank_type 0` (enum only has Invalid/Normal).

## Deployment

`./push.sh` (repo root): runs the release binary's `fetch`, then pushes all three data files to host `wtaylor-deb` at `~/deadlock-lwc-data/` (which the `deadlock-lwc` container serves read-only at `/data/`), per file:

- **match-history.json** — heartbeat: if the sha256 is unchanged it `touch`es the remote file so the mtime still advances (the app judges local-data freshness by mtime — an idle stretch without new matches must not read as a dead poller). Changed content is pushed atomically (tmp+rename).
- **rank-data.json / hero-mmr.json** — skip-if-unchanged (no touch); absent locally (source fetch failed) → skipped.

All ssh is BatchMode (key auth must already work). Requires an up-to-date `target/release/deadlock-gc-history`; rebuild before running it.
