#!/usr/bin/env bash
# Checks for actions/wait/wait.sh, run against a stub fs-cli that records its
# arguments. No network, no real CLI.
#
# Run it directly: bash actions/wait/__tests__/action.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/../wait.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/fs-wait-action-test.XXXXXX")"
ARGS="$WORK/args.txt"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/bin"
# The stub writes to the path it is given rather than a literal, so the work
# directory stays in one place in this file.
cat > "$WORK/bin/fs-cli" <<'STUB'
#!/usr/bin/env bash
printf '%s ' "$@" > "$FS_CLI_ARGS_FILE"
printf 'FS_TOKEN=%s' "${FS_TOKEN:-unset}" >> "$FS_CLI_ARGS_FILE"
exit ${FAKE_EXIT:-0}
STUB
chmod +x "$WORK/bin/fs-cli"

export FS_CLI_ARGS_FILE="$ARGS"
PATH="$WORK/bin:$PATH"
export PATH

failures=0

# Runs wait.sh with a clean input environment plus whatever the caller passes as
# NAME=value pairs. `env` is used rather than a prefixed call so the assignments
# cannot leak into this shell — whether they do for a function is bash-version
# dependent, and a leaked PATH would make a later case pass for the wrong reason.
#
# args.txt is removed first, so a case that must not reach fs-cli cannot read a
# previous case's arguments and call them its own.
run_wait() {
  rm -f "$ARGS"
  env -u INPUT_API_TOKEN -u INPUT_DOMAIN -u INPUT_VERSION_ID -u INPUT_TIMEOUT \
    -u FINITE_STATE_AUTH_TOKEN -u FINITE_STATE_DOMAIN -u FINITE_STATE_VERSION_ID \
    "$@" bash "$SCRIPT" 2>&1
}

# Substring match — for log lines and argument lists.
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

# Exact match — for exit codes, where a substring test would let 10 pass as 0.
check_eq() {
  local name="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    echo "ok   - $name"
  else
    echo "FAIL - $name"
    echo "       expected exactly: $expected"
    echo "       actual:           $actual"
    failures=$((failures + 1))
  fi
}

check_no_fs_cli() {
  local name="$1"
  if [ ! -e "$ARGS" ]; then
    echo "ok   - $name"
  else
    echo "FAIL - $name"
    echo "       fs-cli was called with: $(cat "$ARGS")"
    failures=$((failures + 1))
  fi
}

CTX=(FINITE_STATE_AUTH_TOKEN=tok FINITE_STATE_DOMAIN=example.finitestate.io FINITE_STATE_VERSION_ID=ver123)

# ── Happy path: context only, no timeout ──────────────────────────────────────
out=$(run_wait "${CTX[@]}")
check_eq "exits 0 on a clean scan" 0 "$?"
check "queries the version from the context" \
  "query --type scan --format json --endpoint https://example.finitestate.io --version-id ver123 --wait --fail-on-scan-incomplete" \
  "$(cat "$ARGS")"
check "passes the token via FS_TOKEN, not argv" "FS_TOKEN=tok" "$(cat "$ARGS")"
check "masks the token" "::add-mask::tok" "$out"
check "reports the version it finished waiting on" "Scans on version ver123 finished." "$out"

# ── Defaults ──────────────────────────────────────────────────────────────────
run_wait FINITE_STATE_AUTH_TOKEN=tok FINITE_STATE_VERSION_ID=ver123 >/dev/null
check "falls back to the default domain" "--endpoint https://app.finitestate.io" "$(cat "$ARGS")"

# ── Inputs override the context ───────────────────────────────────────────────
run_wait "${CTX[@]}" INPUT_VERSION_ID=override >/dev/null
check "version-id input wins over the env" "--version-id override" "$(cat "$ARGS")"

run_wait "${CTX[@]}" INPUT_API_TOKEN=intok INPUT_DOMAIN=other.io >/dev/null
check "api-token input wins over the env" "FS_TOKEN=intok" "$(cat "$ARGS")"
check "domain input wins over the env" "--endpoint https://other.io" "$(cat "$ARGS")"

# ── Whitespace ────────────────────────────────────────────────────────────────
run_wait "${CTX[@]}" "INPUT_VERSION_ID=  spaced
" "INPUT_TIMEOUT= 1800 " >/dev/null
check "trims a padded version-id" "--version-id spaced" "$(cat "$ARGS")"
check "trims a padded timeout" "--poll-timeout 30" "$(cat "$ARGS")"

# ── Timeout handling ──────────────────────────────────────────────────────────
run_wait "${CTX[@]}" INPUT_TIMEOUT=1800 >/dev/null
check "converts a whole-minute timeout" "--poll-timeout 30" "$(cat "$ARGS")"

out=$(run_wait "${CTX[@]}" INPUT_TIMEOUT=90)
check "rounds a part-minute timeout up" "--poll-timeout 2" "$(cat "$ARGS")"
check "warns when rounding the timeout" "::warning title=Timeout rounded" "$out"

# A leading zero must not be read as octal: 0600 is 600 seconds, so 10 minutes.
run_wait "${CTX[@]}" INPUT_TIMEOUT=0600 >/dev/null
check "reads a leading-zero timeout as decimal" "--poll-timeout 10" "$(cat "$ARGS")"

# Bare bash arithmetic aborts on 09 ("value too great for base"); this must not.
run_wait "${CTX[@]}" INPUT_TIMEOUT=09 >/dev/null
check "survives a leading zero that is not a valid octal digit" "--poll-timeout 1" "$(cat "$ARGS")"

out=$(run_wait "${CTX[@]}" INPUT_TIMEOUT=600s)
check_eq "exits 1 on a timeout with a unit suffix" 1 "$?"
check "rejects a timeout with a unit suffix" "must be a whole number of seconds" "$out"
check_no_fs_cli "does not call fs-cli on a bad timeout"

out=$(run_wait "${CTX[@]}" INPUT_TIMEOUT=0)
check "rejects a zero timeout" "must be a positive number of seconds" "$out"
check_no_fs_cli "does not call fs-cli on a zero timeout"

# ── Missing prerequisites ─────────────────────────────────────────────────────
out=$(run_wait FINITE_STATE_AUTH_TOKEN=tok FINITE_STATE_DOMAIN=d)
check_eq "exits 1 without a version ID" 1 "$?"
check "fails without a version ID" "::error title=No version ID" "$out"
check_no_fs_cli "does not call fs-cli without a version ID"

out=$(run_wait FINITE_STATE_DOMAIN=d FINITE_STATE_VERSION_ID=v)
check "fails without a token" "::error title=No API token" "$out"

out=$(run_wait "${CTX[@]}" PATH=/usr/bin:/bin)
check_eq "exits 1 when fs-cli is not on PATH" 1 "$?"
check "fails when fs-cli is not on PATH" "::error title=fs-cli not found" "$out"

# ── fs-cli's own verdict decides the step ─────────────────────────────────────
out=$(run_wait "${CTX[@]}" FAKE_EXIT=7)
check_eq "propagates fs-cli's exit code" 7 "$?"
check "annotates an unfinished scan" "::error title=Scan did not finish" "$out"
check "names the version in the failure" "for version ver123" "$out"

echo
if [ "$failures" -ne 0 ]; then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all checks passed"
