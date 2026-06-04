#!/bin/bash
# LaunchAgent entrypoint for every cronfish job.
# Resolves bun, sources .env from the consumer repo, execs runner.ts.
#
# CRONFISH_CONSUMER_ROOT is set by the plist template. For manual invocation
# without it, we fall back to $PWD (cli.ts spawns runner.sh with cwd = consumer
# root). Last-ditch: walk up from the job file path looking for a .cronfish.json
# or cron/ directory.
set -eo pipefail

CONSUMER_ROOT="${CRONFISH_CONSUMER_ROOT:-}"
if [[ -z "${CONSUMER_ROOT}" ]]; then
  CONSUMER_ROOT="$(pwd)"
fi

ENV_FILE="${CONSUMER_ROOT}/.env"

BUN=""
for cand in \
  "${HOME}/.bun/bin/bun" \
  "${HOME}/.asdf/installs/nodejs/22.13.1/bin/bun" \
  "/opt/homebrew/bin/bun" \
  "/usr/local/bin/bun"; do
  if [[ -x "${cand}" ]]; then BUN="${cand}"; break; fi
done
if [[ -z "${BUN}" ]]; then BUN="$(command -v bun 2>/dev/null || true)"; fi
if [[ -z "${BUN}" ]]; then
  echo "[cronfish] ERROR: bun not found" >&2
  exit 1
fi

if [[ -s "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

export CRONFISH_CONSUMER_ROOT="${CONSUMER_ROOT}"

RUNNER_TS="$(cd "$(dirname "$0")" && pwd)/runner.ts"
exec "${BUN}" "${RUNNER_TS}" "$@"
