#!/bin/sh
# Stops the instance created by start.sh and deletes its folder.
# Usage: stop.sh FOLDER [--keep]   (--keep preserves the folder, for example to save evidence)
set -eu

BASE=${1:?usage: stop.sh FOLDER [--keep]}
KEEP=${2:-}
[ -f "$BASE/.aae-isolated" ] || { echo "$BASE is not an instance created by start.sh." >&2; exit 1; }

if [ -f "$BASE/server.pid" ]; then
  PID=$(cat "$BASE/server.pid")
  # Only stop it if the PID is still this instance's server (the PID may have been reused).
  if tr '\0' ' ' < "/proc/$PID/cmdline" 2>/dev/null | grep -q -F -- "--state-dir $BASE/state"; then
    kill "$PID"
    echo "Server $PID stopped."
  else
    echo "No server from this instance is running."
  fi
fi

if [ "$KEEP" = "--keep" ]; then
  echo "Folder kept: $BASE"
else
  rm -rf -- "$BASE"
  echo "Folder removed: $BASE"
fi
