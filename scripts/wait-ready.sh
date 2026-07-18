#!/usr/bin/env bash
set -euo pipefail

api_url="${AI_API_URL:-http://127.0.0.1:${AI_API_PORT:-4417}}"
attempts="${AI_READY_ATTEMPTS:-40}"

for ((attempt = 1; attempt <= attempts; attempt += 1)); do
  if curl --fail --silent --show-error --max-time 1 "${api_url%/}/ready" >/dev/null 2>&1; then
    exit 0
  fi
  sleep 1
done

printf 'AI Workbench did not become ready at %s/ready\n' "${api_url%/}" >&2
exit 1
