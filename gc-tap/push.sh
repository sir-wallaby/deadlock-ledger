#!/bin/sh
# Fetch own-account Deadlock data from the Steam GC and publish it to
# wtaylor-deb, where the deadlock-lwc container serves it at /data/.
#
#   match-history.json  heartbeat: mtime advances every run even when the
#                       content is unchanged (the app judges freshness by mtime)
#   rank-data.json      own-account ranked state (SO cache + GetRankData)
#   hero-mmr.json       per-hero relative MMR (GetHeroMMRRankings)
#   match-meta.json     per-match metadata (per-match MMR + match info)
set -eu

BIN=/home/wtaylor/Repo/deadlock-ledger/gc-tap/target/release/deadlock-gc-history
DATA_DIR="$HOME/.local/share/deadlock-gc-history"
REMOTE="wtaylor-deb"
REMOTE_DIR="$HOME/deadlock-lwc-data"

"$BIN" fetch

remote_hash() {
  ssh -o BatchMode=yes "$REMOTE" \
    "sha256sum '$REMOTE_DIR/$1' 2>/dev/null | cut -d' ' -f1" || true
}

push_file() {
  NAME=$1
  LOCAL_PATH="$DATA_DIR/$NAME"
  [ -f "$LOCAL_PATH" ] || { echo "$NAME: not fetched — skipped"; return 0; }
  LOCAL_HASH=$(sha256sum "$LOCAL_PATH" | cut -d' ' -f1)
  if [ "$(remote_hash "$NAME")" = "$LOCAL_HASH" ]; then
    if [ "$NAME" = match-history.json ]; then
      # Heartbeat: the app judges local-data freshness by this file's mtime,
      # so keep advancing it even when content is unchanged — otherwise any
      # idle stretch without new matches would read as a dead poller.
      ssh -o BatchMode=yes "$REMOTE" "touch '$REMOTE_DIR/$NAME'"
      echo "$NAME: unchanged — touched mtime"
    else
      echo "$NAME: unchanged — skipped"
    fi
    return 0
  fi
  ssh -o BatchMode=yes "$REMOTE" "mkdir -p '$REMOTE_DIR'"
  ssh -o BatchMode=yes "$REMOTE" \
    "cat > '$REMOTE_DIR/$NAME.tmp' && mv -f '$REMOTE_DIR/$NAME.tmp' '$REMOTE_DIR/$NAME'" \
    < "$LOCAL_PATH"
  echo "pushed $NAME"
}

for NAME in match-history.json rank-data.json hero-mmr.json match-meta.json; do
  push_file "$NAME"
done
