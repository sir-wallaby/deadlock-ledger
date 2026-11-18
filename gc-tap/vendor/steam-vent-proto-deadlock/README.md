# steam-vent-proto-deadlock (vendored)

Vendored copy of <https://codeberg.org/steam-vent/proto-deadlock> at
`02dadfa` (2026-06-08), updated in place with newer protos.

## Provenance of the protos

The 10 `citadel_*.proto` + `base_*.proto` files were replaced on 2026-10-06
with the current-game dumps from
<https://github.com/SteamTracking/Protobufs> (`deadlock/` directory). SteamKit
dumper metadata options that the parser rejects (`boxed_type`, `(key_field)`,
`synthetic_default`, `description`, file-level `option (...)` lines, etc.)
were stripped — they carry no wire-format information. All other files are
unchanged from the codeberg crate.

## Regenerating `src/generated/`

Generated with `steam-vent-proto-build` (protobuf-codegen 3.5.1) from
<https://codeberg.org/steam-vent/proto> (`build/`):

```sh
steam-vent-proto-build protos src/generated
```

The tool reproduces the committed output byte-for-byte (verified against the
original codeberg crate), so a full regeneration is safe after swapping protos.

## Why vendored

The codeberg crate is stale (its protos predate the ranked season: no
`player_match_outcome` enum, no `ranked_*` fields). The upstream repo has not
moved since 2026-06-08, so this repo vendors the crate as a path dependency
and keeps it current manually.
