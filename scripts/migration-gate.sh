#!/usr/bin/env bash
#
# Migration gate — the HEAVIER, on-demand gate for the comparison-index migration
# (run when working on the scoped-fetch migration, NOT on every push — the fast
# pre-push gate is scripts/linux-gate.sh). Runs on linux/amd64 with the prod-pinned
# binding. Today: leaderboard parity (query == the comparison tables). As the migration
# proceeds, add render-equivalence + the by_model consumer test here.
#
# Usage:  scripts/migration-gate.sh
#         SNAPSHOT_URL=<post-rebaseline snapshot> scripts/migration-gate.sh   # re-verify after the registry rebaseline
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# Default to the latest published snapshot; pin by exporting SNAPSHOT_URL first.
if [ -z "${SNAPSHOT_URL:-}" ]; then
  echo "[migration-gate] resolving latest published snapshot (set SNAPSHOT_URL to pin)…"
  SNAPSHOT_URL="$(node "$ROOT/scripts/resolve-latest-snapshot.mjs")" || {
    echo "[migration-gate] could not resolve latest snapshot — set SNAPSHOT_URL explicitly" >&2
    exit 2
  }
fi

DUCKDB_VERSION="$(grep -m1 -oE '@duckdb/node-api@[0-9][A-Za-z0-9.+-]*' pnpm-lock.yaml | sed 's#.*@##' || true)"
DUCKDB_VERSION="${DUCKDB_VERSION:-1.5.3-r.2}"
echo "[migration-gate] binding @duckdb/node-api@${DUCKDB_VERSION}; snapshot ${SNAPSHOT_URL}"
docker build --platform=linux/amd64 --build-arg "DUCKDB_VERSION=${DUCKDB_VERSION}" \
  -t evalcard-linux-gate "$ROOT/scripts/linux-gate" >/dev/null

echo "[migration-gate] leaderboard parity (query vs live comparison tables)…"
docker run --platform=linux/amd64 --rm -e SNAPSHOT_URL="$SNAPSHOT_URL" evalcard-linux-gate parity.mjs

# TODO add as the migration proceeds:
#   - render-equivalence (eval-page leaderboard / histogram bars / whisker N-min-max / DeepDive run-labels)
#   - by_model-removal consumer test (slash/percent/dunder identity resolution)
echo "[migration-gate] PASS ✅"
