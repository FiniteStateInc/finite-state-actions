import * as core from '@actions/core'

/**
 * Turns a `timeout` input in seconds into the whole minutes fs-cli accepts.
 *
 * Returns undefined for an empty input, which leaves fs-cli its own 30-minute
 * default rather than a bound this action invented. Shared by every action with
 * a `timeout` input so the parsing, the rejections, and the rounding warning
 * cannot drift apart between them.
 */
export function parseTimeoutMinutes(input: string | undefined): number | undefined {
  const timeout = (input ?? '').trim()
  if (!timeout) {
    return undefined
  }

  // Deliberately strict: parseInt would read "600s" as 600 and "10 minutes" as
  // 10, quietly applying a bound the caller did not ask for.
  if (!/^\d+$/.test(timeout)) {
    throw new Error(
      `timeout must be a whole number of seconds, got "${timeout}". ` +
        `Leave it unset to use fs-cli's own default.`,
    )
  }

  const seconds = parseInt(timeout, 10)
  if (seconds <= 0) {
    throw new Error(`timeout must be a positive number of seconds, got "${timeout}".`)
  }

  const minutes = Math.max(1, Math.ceil(seconds / 60))
  // fs-cli takes whole minutes, so anything that is not an exact multiple of 60
  // rounds up — say which bound will actually apply rather than waiting longer
  // than asked without mentioning it.
  if (seconds % 60 !== 0) {
    core.warning(
      `timeout ${seconds}s is not a whole number of minutes, which is all fs-cli accepts; ` +
        `rounding up to ${minutes} minute(s).`,
    )
  }

  return minutes
}
