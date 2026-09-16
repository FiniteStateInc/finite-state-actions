#!/usr/bin/env bash
# Checks for actions/wait/wait.sh, run against a stub fs-cli that records its
# arguments. No network, no real CLI.
#
# Run it directly: bash actions/wait/__tests__/action.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/../wait.sh"
WORK=/tmp/fs-wait-action-test
ARGS="$WORK/args.txt"

mkdir -p "$WORK/bin"
cat > "$WORK/bin/fs-cli" <<'STUB'
#!/usr/bin/env bash
printf '%s ' "$@" > /tmp/fs-wait-action-test/args.txt
printf 'FS_TOKEN=%s' "${FS_TOKEN:-unset}" >> /tmp/fs-wait-action-test/args.txt
exit ${FAKE_EXIT:-0}
STUB
chmod +x "$WORK/bin/fs-cli"

PATH="$WORK/bin:$PATH"
export PATH

failures=0

# Runs wait.sh with a clean input environment plus whatever the caller exports.
run_wait() {
  env -u INPUT_API_TOKEN -u INPUT_DOMAIN -u INPUT_VERSION_ID -u INPUT_TIMEOUT \
    -u FINITE_STATE_AUTH_TOKEN -u FINITE_STATE_DOMAIN -u FINITE_STATE_VERSION_ID \
    "$@" bash "$SCRIPT" 2>&1
}

check() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$actual" == *"$expected"* ]]; then
    echo "ok   - $name"
  else
    echo "FAIL - $name"
    echo "       expected to contain: $expected"
    echo "       actual:              $actual"
    failures=$((failures + 1))
  fi
}

CTX=(FINITE_STATE_AUTH_TOKEN=tok FINITE_STATE_DOMAIN=example.finitestate.io FINITE_STATE_VERSION_ID=ver123)

# ── Happy path: context only, no timeout ──────────────────────────────────────
out=$(run_wait "${CTX[@]}")
code=$?
check "exits 0 on a clean scan" "0" "$code"
check "queries the version from the context" \
  "query --type scan --format json --endpoint https://example.finitestate.io --version-id ver123 --wait --fail-on-scan-incomplete" \
  "$(cat "$ARGS")"
check "passes the token via FS_TOKEN, not argv" "FS_TOKEN=tok" "$(cat "$ARGS")"

# ── Inputs override the context ───────────────────────────────────────────────
run_wait "${CTX[@]}" INPUT_VERSION_ID=override >/dev/null
check "version-id input wins over the env" "--version-id override" "$(cat "$ARGS")"

run_wait "${CTX[@]}" INPUT_API_TOKEN=intok INPUT_DOMAIN=other.io >/dev/null
check "api-token input wins over the env" "FS_TOKEN=intok" "$(cat "$ARGS")"
check "domain input wins over the env" "--endpoint https://other.io" "$(cat "$ARGS")"

# ── Timeout handling ──────────────────────────────────────────────────────────
run_wait "${CTX[@]}" INPUT_TIMEOUT=1800 >/dev/null
check "converts a whole-minute timeout" "--poll-timeout 30" "$(cat "$ARGS")"

out=$(run_wait "${CTX[@]}" INPUT_TIMEOUT=90)
check "rounds a part-minute timeout up" "--poll-timeout 2" "$(cat "$ARGS")"
check "warns when rounding the timeout" "::warning title=Timeout rounded" "$out"

out=$(run_wait "${CTX[@]}" INPUT_TIMEOUT=600s)
check "rejects a timeout with a unit suffix" "must be a whole number of seconds" "$out"

out=$(run_wait "${CTX[@]}" INPUT_TIMEOUT=0)
check "rejects a zero timeout" "must be a positive number of seconds" "$out"

# ── Missing prerequisites ─────────────────────────────────────────────────────
out=$(run_wait FINITE_STATE_AUTH_TOKEN=tok FINITE_STATE_DOMAIN=d)
code=$?
check "fails without a version ID" "::error title=No version ID" "$out"
check "exits non-zero without a version ID" "1" "$code"

out=$(run_wait FINITE_STATE_DOMAIN=d FINITE_STATE_VERSION_ID=v)
check "fails without a token" "::error title=No API token" "$out"

out=$(PATH=/usr/bin:/bin run_wait "${CTX[@]}")
check "fails when fs-cli is not on PATH" "::error title=fs-cli not found" "$out"

# ── fs-cli's own verdict decides the step ─────────────────────────────────────
run_wait "${CTX[@]}" FAKE_EXIT=1 >/dev/null
check "fails when fs-cli reports an incomplete scan" "1" "$?"

echo
if [ "$failures" -ne 0 ]; then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all checks passed"
