#!/usr/bin/env bash
# Waits for the Finite State platform to finish scanning a version.
#
# Run by action.yml, which passes every input through the environment. Kept in
# its own file rather than inline in the YAML so __tests__/action.test.sh can
# run it directly.
#
# Inputs (all optional, all from the environment):
#   INPUT_API_TOKEN, INPUT_DOMAIN, INPUT_VERSION_ID, INPUT_TIMEOUT
# Falls back to the context setup/scan/upload export:
#   FINITE_STATE_AUTH_TOKEN, FINITE_STATE_DOMAIN, FINITE_STATE_VERSION_ID
set -euo pipefail

# Inputs win over the context setup/scan/upload exported.
TOKEN="${INPUT_API_TOKEN:-${FINITE_STATE_AUTH_TOKEN:-}}"
DOMAIN="${INPUT_DOMAIN:-${FINITE_STATE_DOMAIN:-app.finitestate.io}}"
VERSION_ID="${INPUT_VERSION_ID:-${FINITE_STATE_VERSION_ID:-}}"
TIMEOUT="${INPUT_TIMEOUT:-}"

if [ -z "$TOKEN" ]; then
  echo "::error title=No API token::Run setup, scan or upload first, or pass api-token."
  exit 1
fi

if [ -z "$VERSION_ID" ]; then
  echo "::error title=No version ID::FINITE_STATE_VERSION_ID is not set. Run scan or upload first, or pass version-id. It is the platform's version ID, not a label like v1.2.3."
  exit 1
fi

if ! command -v fs-cli >/dev/null 2>&1; then
  echo "::error title=fs-cli not found::This action does not install fs-cli. Run setup, scan or upload earlier in the same job — each of those adds it to PATH."
  exit 1
fi

# fs-cli counts in whole minutes; the input is seconds, matching upload's
# timeout. Rounds up, so anything under a minute waits a minute.
POLL_TIMEOUT=()
if [ -n "$TIMEOUT" ]; then
  # Deliberately strict: bash arithmetic would read "600s" as 600.
  case "$TIMEOUT" in
    *[!0-9]*)
      echo "::error title=Bad timeout::timeout must be a whole number of seconds, got \"$TIMEOUT\". Leave it unset for fs-cli's 30-minute default."
      exit 1
      ;;
  esac
  if [ "$TIMEOUT" -le 0 ]; then
    echo "::error title=Bad timeout::timeout must be a positive number of seconds, got \"$TIMEOUT\"."
    exit 1
  fi
  MINUTES=$(((TIMEOUT + 59) / 60))
  if [ $((TIMEOUT % 60)) -ne 0 ]; then
    echo "::warning title=Timeout rounded::timeout ${TIMEOUT}s is not a whole number of minutes, which is all fs-cli accepts; rounding up to ${MINUTES} minute(s)."
  fi
  POLL_TIMEOUT=(--poll-timeout "$MINUTES")
fi

echo "Waiting for scans on version $VERSION_ID to finish."

# --wait polls; --fail-on-scan-incomplete fails the step on a failed scan, a
# poll timeout, or a version with no scans at all, so a later step never reads
# partial results from a green job. The token goes through FS_TOKEN so it stays
# out of the process argument list.
#
# The ${arr[@]+...} guard is there because `set -u` makes an empty array
# expansion an error in bash 3.2, which is what macOS runners ship.
FS_TOKEN="$TOKEN" fs-cli query \
  --type scan \
  --format json \
  --endpoint "https://${DOMAIN}" \
  --version-id "$VERSION_ID" \
  --wait \
  ${POLL_TIMEOUT[@]+"${POLL_TIMEOUT[@]}"} \
  --fail-on-scan-incomplete
