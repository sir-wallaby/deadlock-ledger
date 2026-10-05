# AGENTS.md

Single-binary Rust CLI (edition 2021). Fetches own-account Deadlock (Steam appid 1422450) match history directly from the Steam Game Coordinator (GC message 9112), bypassing third-party APIs. No tests, no CI, no lint config. Local git repo (branch `main`), not yet pushed — plan: create an empty **private** GitHub repo `deadlock-gc-history`, then `git remote add origin git@github.com:<user>/deadlock-gc-history.git && git push -u origin main`. All app code is in `src/main.rs`.

## Build & run

```sh
cargo build --release
cargo clippy --all-targets   # keep at zero warnings (default lints)
./target/release/deadlock-gc-history status     # offline state check
./target/release/deadlock-gc-history check      # safe end-to-end verify (writes /dev/null)
./target/release/deadlock-gc-history fetch      # writes match-history.json
```

## Commands (subcommands are hand-parsed, no clap)

- `login` — **interactive only** (password prompt, may request a Steam Guard code on the console). An agent cannot run it headless. If `fetch`/`check` fails with "no saved refresh token" or "refresh token expired", ask the user to run `login`.
- `fetch` — headless; needs a valid refresh token + network access to Steam. Optional `--out PATH`.
- `check` — like `fetch` but discards output. This is the right post-change verification step (besides `cargo check`).
- `status` — offline; shows config/token/data state.

## State files (XDG paths)

- config: `~/.config/deadlock-gc-history/config.json`
- refresh token: `~/.local/share/deadlock-gc-history/refresh_token` (mode 0600)
- data: `~/.local/share/deadlock-gc-history/match-history.json`

## Vendored dependencies — read before touching Steam protocol code

- `vendor/steam-vent` is a **path dependency vendored in-repo** (not a git submodule). If Steam client behavior is wrong, edit it there.
- `steam-vent-proto-deadlock` comes from a **git dependency** (codeberg). Its protos predate the ranked season: no `ranked_*` fields, no penalized/not-scored outcome enum values. `player_match_outcome` is synthesized as 1 (win) / 2 (loss) in `src/main.rs` — don't "fix" it against the newer public API unless the proto dep is updated.

## Output contract

`match-history.json` is a JSON array mirroring `api.deadlock-api.com /v1/players/{id}/match-history` (fields in `MatchOut`, `src/main.rs`). Downstream consumer: the `deadlock-lwc` container. Preserve the shape when changing output.

## Deployment

`./push.sh` (repo root): runs the release binary's `fetch`, then either pushes via ssh (BatchMode — key auth must already work) to host `wtaylor-deb` at `~/deadlock-lwc-data/match-history.json` (which the `deadlock-lwc` container serves at `/data/`) or, if the sha256 is unchanged, `touch`es the remote file. The touch is a deliberate heartbeat: the app judges data freshness by the file's mtime, so it must advance on every run even when no new matches were played. Requires an up-to-date `target/release/deadlock-gc-history`; rebuild before running it.
