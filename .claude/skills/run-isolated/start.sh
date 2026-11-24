#!/bin/sh
# Starts an isolated Agent Architecture Explorer instance: free port, temporary state and HOME.
# Usage: start.sh [--lab] [--port N]
#   --lab      creates the synthetic audit lab in the temporary HOME
#   --port N   uses port N (default: a free port picked by the system)
# Prints the URL, PID and instance folder. To stop it: stop.sh FOLDER.
set -eu

ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
LAB=0
PORT=
while [ $# -gt 0 ]; do
  case "$1" in
    --lab) LAB=1 ;;
    --port) PORT=${2:?--port needs a number}; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

[ -f "$ROOT/dist/index.html" ] || { echo "dist/ is missing: run npm run build first." >&2; exit 1; }
if [ -z "$PORT" ]; then
  PORT=$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')
fi
case "$PORT" in
  47831 | 47839) echo "Port $PORT is reserved (personal installation or Playwright)." >&2; exit 1 ;;
esac

BASE=$(mktemp -d "${TMPDIR:-/tmp}/aae-isolated-XXXXXX")
# On any failure before the server responds, stop what started and delete the folder.
cleanup() {
  if [ -f "$BASE/server.pid" ] && kill -0 "$(cat "$BASE/server.pid")" 2>/dev/null; then kill "$(cat "$BASE/server.pid")"; fi
  rm -rf -- "$BASE"
}
trap cleanup EXIT
touch "$BASE/.aae-isolated"
mkdir -p "$BASE/home" "$BASE/state"

# With HOME swapped, the server would not read the machine's protected-paths.txt: copy it with ~ expanded.
REAL_FILE="$HOME/.local/share/agent-architecture-explorer/state/protected-paths.txt"
if [ -f "$REAL_FILE" ]; then
  python3 - "$REAL_FILE" "$BASE/state/protected-paths.txt" "$HOME" <<'PY'
import sys
source, target, home = sys.argv[1:]
lines = []
for line in open(source, encoding='utf-8').read().splitlines():
    entry = line.strip()
    lines.append(home + entry[1:] if entry == '~' or entry.startswith('~/') else line)
open(target, 'w', encoding='utf-8').write('\n'.join(lines) + '\n')
PY
fi

if [ "$LAB" = 1 ]; then
  python3 "$ROOT/tests/create_audit_lab.py" --destination "$BASE/home/lab" > "$BASE/lab.json"
fi

cd "$ROOT"
HOME="$BASE/home" setsid nohup python3 server/main.py --port "$PORT" --state-dir "$BASE/state" \
  > "$BASE/server.log" 2>&1 < /dev/null &
echo $! > "$BASE/server.pid"

tries=0
until python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:$PORT/', timeout=1)" 2>/dev/null; do
  tries=$((tries + 1))
  if [ "$tries" -gt 50 ] || ! kill -0 "$(cat "$BASE/server.pid")" 2>/dev/null; then
    echo "The server did not respond. Log at $BASE/server.log:" >&2
    cat "$BASE/server.log" >&2
    exit 1
  fi
  sleep 0.2
done
trap - EXIT

echo "URL:    http://127.0.0.1:$PORT/"
echo "PID:    $(cat "$BASE/server.pid")"
echo "Folder: $BASE (temporary HOME in home/, state in state/, log in server.log)"
[ "$LAB" = 1 ] && echo "Lab:    $BASE/home/lab (roots and oracle in $BASE/lab.json)"
echo "Stop:   $ROOT/.claude/skills/run-isolated/stop.sh $BASE"
