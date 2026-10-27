#!/bin/sh
# ============================================================================
#  DSH internal plugin marketplace -- server launcher (Linux / macOS / WSL)
#
#  Usage:
#    ./start-market.sh                 start with defaults
#    ./start-market.sh --port 9000     use another port
#    ./start-market.sh --host 0.0.0.0  let other machines on the LAN connect
#    ./start-market.sh --data /var/lib/dsh-market   keep data outside the checkout
#    ./start-market.sh --check         verify the environment, do not start
#    ./start-market.sh --help
#
#  Data lives in .market/ beside this script (database + artifacts).
#  The first run creates the database and the admin account
#  admin / dsh-admin, which must change its password on first login.
#
#  This script is POSIX sh on purpose: it also runs as the ENTRYPOINT of the
#  Alpine-based container, which has no bash.
# ============================================================================
set -eu

# Resolve this script's directory, then work from it. Data and relative --data
# paths must not depend on where the caller happened to stand.
SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd -P)
cd "$SCRIPT_DIR"

MARKET_HOST=${MARKET_HOST:-127.0.0.1}
MARKET_PORT=${MARKET_PORT:-8787}
MARKET_DATA_DIR=${MARKET_DATA_DIR:-$SCRIPT_DIR/.market}
CHECK_ONLY=0

usage() {
  cat <<'USAGE'
Usage: ./start-market.sh [--port PORT] [--host ADDR] [--data DIR] [--check]

  --port PORT   listen port (default: 8787, env MARKET_PORT)
  --host ADDR   listen address (default: 127.0.0.1, env MARKET_HOST)
  --data DIR    data directory (default: .market beside this script,
                env MARKET_DATA_DIR)
  --check       verify Node, paths and permissions, then exit
  --help        show this help
USAGE
}

die() {
  printf '\n[ERROR] %s\n\n' "$*" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --port)
      [ $# -ge 2 ] || die "--port needs a value"
      MARKET_PORT=$2
      shift 2
      ;;
    --host)
      [ $# -ge 2 ] || die "--host needs a value"
      MARKET_HOST=$2
      shift 2
      ;;
    --data)
      [ $# -ge 2 ] || die "--data needs a value"
      MARKET_DATA_DIR=$2
      shift 2
      ;;
    --check)
      CHECK_ONLY=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "Unknown argument: $1"
      ;;
  esac
done

# ---- validate arguments ----------------------------------------------------
case "$MARKET_PORT" in
  ''|*[!0-9]*) die "Invalid port: $MARKET_PORT (expected 1-65535)" ;;
esac
if [ "$MARKET_PORT" -lt 1 ] || [ "$MARKET_PORT" -gt 65535 ]; then
  die "Port out of range: $MARKET_PORT (expected 1-65535)"
fi
[ -n "$MARKET_HOST" ] || die "--host needs a non-empty address"

# A relative --data means "relative to the project", exactly like the .bat.
case "$MARKET_DATA_DIR" in
  /*) ;;
  *) MARKET_DATA_DIR="$SCRIPT_DIR/$MARKET_DATA_DIR" ;;
esac

# When bound to a concrete LAN address, the service should also report that
# address rather than 127.0.0.1. A wildcard bind (0.0.0.0 / ::) tells us nothing
# about how clients reach the machine, so it must not become the callback host —
# and an explicitly provided MARKET_CALLBACK_HOST always wins.
if [ -z "${MARKET_CALLBACK_HOST:-}" ]; then
  case "$MARKET_HOST" in
    127.0.0.1|0.0.0.0|::|::1) ;;
    *) MARKET_CALLBACK_HOST=$MARKET_HOST ;;
  esac
fi

export MARKET_HOST MARKET_PORT MARKET_DATA_DIR
if [ -n "${MARKET_CALLBACK_HOST:-}" ]; then
  export MARKET_CALLBACK_HOST
fi

# ---- locate Node: system PATH first, then the DSH bundled runtime ----------
NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  NODE_BIN=$(command -v node)
fi
if [ -z "$NODE_BIN" ]; then
  for base in "${DSH_HOME:-}" "${HOME:-}/.dsh"; do
    [ -n "$base" ] || continue
    for candidate in \
      "$base"/dsh-runtimes/*/dependencies/node/bin/node \
      "$base"/dsh-runtimes/*/node/bin/node; do
      if [ -x "$candidate" ]; then
        NODE_BIN=$candidate
        break 2
      fi
    done
  done
fi
[ -n "$NODE_BIN" ] || die "node not found.
  Install Node 22.5 or newer, or make sure the DSH bundled runtime exists."

# ---- version gate: node:sqlite needs 22.5+ --------------------------------
VERSION_PROBE='
const p = process.versions.node.split(".").map(Number)
const ok = p[0] > 22 || (p[0] === 22 && p[1] >= 5)
process.stdout.write(process.versions.node + (ok ? "" : " TOO_OLD") + "\n")
process.exit(ok ? 0 : 1)
'
if ! NODE_VERSION=$("$NODE_BIN" -e "$VERSION_PROBE" 2>/dev/null); then
  die "Node at $NODE_BIN is unusable or older than 22.5.
  The server needs Node 22.5 or newer for the built-in node:sqlite."
fi

# ---- must run from the project root ---------------------------------------
[ -f server/index.mjs ] || die "This does not look like the project root: $PWD
  expected to find server/index.mjs"

# MARKET_DB may override the database file, exactly as server/lib/paths.js does.
DB_PATH=${MARKET_DB:-$MARKET_DATA_DIR/market.db}
case "$DB_PATH" in
  /*) ;;
  *) DB_PATH="$SCRIPT_DIR/$DB_PATH" ;;
esac

if [ "$CHECK_ONLY" -eq 1 ]; then
  echo "Environment OK."
  printf '  Node        %s  (%s)\n' "$NODE_BIN" "$NODE_VERSION"
  printf '  Data dir    %s\n' "$MARKET_DATA_DIR"
  printf '  Database    %s\n' "$DB_PATH"
  printf '  Listen      %s:%s\n' "$MARKET_HOST" "$MARKET_PORT"
  if [ -d "$MARKET_DATA_DIR" ]; then
    if [ -w "$MARKET_DATA_DIR" ]; then
      printf '  Writable    yes\n'
    else
      printf '  Writable    NO -- choose another --data or fix permissions\n'
    fi
  else
    parent_dir=$(dirname "$MARKET_DATA_DIR")
    if [ -d "$parent_dir" ] && [ -w "$parent_dir" ]; then
      printf '  Writable    parent is writable; the directory will be created\n'
    else
      printf '  Writable    NO -- parent %s is missing or not writable\n' "$parent_dir"
    fi
  fi
  exit 0
fi

# ---- first run: create the database and the admin account -----------------
if [ ! -f "$DB_PATH" ]; then
  echo
  echo "First run: initialising the database..."
  "$NODE_BIN" server/cli.mjs bootstrap || die "Initialisation failed."
  echo
fi

# 0.0.0.0 in a URL is not something a human can open; show the loopback one.
DISPLAY_HOST=$MARKET_HOST
case "$MARKET_HOST" in
  0.0.0.0|::) DISPLAY_HOST=127.0.0.1 ;;
esac

cat <<EOF
===========================================================================
 DSH internal plugin marketplace - server
---------------------------------------------------------------------------
  Listening   ${MARKET_HOST}:${MARKET_PORT}
  Data dir    ${MARKET_DATA_DIR}
  Node        ${NODE_BIN}  (${NODE_VERSION})

  Health      http://${DISPLAY_HOST}:${MARKET_PORT}/dsh-market/health
  Console     http://${DISPLAY_HOST}:${MARKET_PORT}/console
  Market page open DSH and click "Internal plugin market" in the sidebar
              footer (served by the DSH host plugin, not by this port)

  Press Ctrl+C to stop.
===========================================================================
EOF

if [ "$MARKET_HOST" = "0.0.0.0" ] || [ "$MARKET_HOST" = "::" ]; then
  echo "  Bound to ${MARKET_HOST}: colleagues connect via this machine's LAN address."
  echo
fi

exec "$NODE_BIN" server/index.mjs
