#!/usr/bin/env bash
# Tear down the local dev Postgres.
# - With Docker: docker compose down (keeps the volume by default).
# - Without Docker: leaves the system cluster running; only the dev DB is dropped.
# Add --volumes to also drop the Docker named volume (DESTROYS DATA).

set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DROP_VOLUMES=0
if [ "${1:-}" = "--volumes" ]; then
  DROP_VOLUMES=1
fi

DB_NAME="${POSTGRES_DB:-tilbudstrolden}"

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  if [ "$DROP_VOLUMES" -eq 1 ]; then
    echo "→ docker compose down -v (DESTROYS data)" >&2
    docker compose down -v
  else
    echo "→ docker compose stop" >&2
    docker compose stop db
  fi
  exit 0
fi

if command -v psql >/dev/null 2>&1; then
  if [ "$DROP_VOLUMES" -eq 1 ]; then
    echo "→ Dropping system Postgres database '$DB_NAME' (DESTROYS data)" >&2
    sudo -u postgres psql -c "DROP DATABASE IF EXISTS \"$DB_NAME\"" >/dev/null
  else
    echo "→ System Postgres cluster left running. Use --volumes to drop database." >&2
  fi
  exit 0
fi

echo "Nothing to tear down — no docker compose or system Postgres detected." >&2
