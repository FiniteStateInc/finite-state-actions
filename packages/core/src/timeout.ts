/**
 * Turns a `timeout` input in seconds into the whole minutes fs-cli accepts,
 * with the annotation to emit when that conversion is not exact.
 *
 * `minutes` is undefined for an empty input, which leaves fs-cli its own
 * 30-minute default rather than a bound this action invented. Shared by every
 * action with a `timeout` input so the parsing, the rejections, and the
 * rounding cannot drift apart between them.
 *
 * Returns the rounding message rather than writing it, so the caller titles it
 * and core stays usable without the Actions logging channel.
 */
export function timeoutSecondsToMinutes(input: string | undefined): {
  minutes?: number
  warning?: string
} {
  const timeout = (input ?? '').trim()
  if (!timeout) {
    return {}
  }

  // Deliberately strict: parseInt would read "600s" as 600 and "10 minutes" as
  // 10, quietly applying a bound the caller did not ask for. A leading zero is
  // base 10 here, where the bash implementation this replaced read "0600" as
  // octal 384 and aborted outright on "09".
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
    return {
      minutes,
      warning:
        `timeout ${seconds}s is not a whole number of minutes, which is all fs-cli accepts; ` +
        `rounding up to ${minutes} minute(s).`,
    }
  }

  return { minutes }
}
