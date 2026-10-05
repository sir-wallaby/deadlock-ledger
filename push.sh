#!/bin/sh
# Fetch own-account Deadlock match history from the Steam GC and publish it
# to wtaylor-deb, where the deadlock-lwc container serves it at /data/.
set -eu

BIN=/home/wtaylor/Repo/deadlock-gc-history/target/release/deadlock-gc-history
DATA="$HOME/.local/share/deadlock-gc-history/match-history.json"
REMOTE="wtaylor-deb"
REMOTE_DIR="$HOME/deadlock-lwc-data"

"$BIN" fetch

LOCAL_HASH=$(sha256sum "$DATA" | cut -d' ' -f1)
REMOTE_HASH=$(ssh -o BatchMode=yes "$REMOTE" \
  "sha256sum '$REMOTE_DIR/match-history.json' 2>/dev/null | cut -d' ' -f1" || true)
if [ "$REMOTE_HASH" = "$LOCAL_HASH" ]; then
  # Heartbeat: the app judges local-data freshness by this file's mtime, so
  # keep advancing it even when content is unchanged — otherwise any idle
  # stretch without new matches would read as a dead poller.
  ssh -o BatchMode=yes "$REMOTE" "touch '$REMOTE_DIR/match-history.json'"
  echo "remote already up to date — touched mtime"
  exit 0
fi

ssh -o BatchMode=yes "$REMOTE" "mkdir -p '$REMOTE_DIR'"
ssh -o BatchMode=yes "$REMOTE" \
  "cat > '$REMOTE_DIR/match-history.json.tmp' && mv -f '$REMOTE_DIR/match-history.json.tmp' '$REMOTE_DIR/match-history.json'" \
  < "$DATA"
echo "pushed to $REMOTE:$REMOTE_DIR/match-history.json"
