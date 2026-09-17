/**
 * Node's `fetch` reports every network-level failure as `TypeError: fetch
 * failed` and keeps the real reason — refused connection, DNS miss, a proxy's
 * TLS rejection, a reset socket — in `cause`. That bare message is all a step
 * prints, so a customer behind a proxy sees `Error: fetch failed` and nothing
 * to act on.
 *
 * `fetchFailure` walks the `cause` chain (and `AggregateError.errors`, which is
 * what a connect to a multi-address host produces) and returns an Error naming
 * the request and every reason code under it.
 *
 * `what` is caller-supplied rather than always the URL because the fs-cli
 * download URL is pre-signed — its query string is a credential and must stay
 * out of the log.
 */
export function fetchFailure(what: string, err: unknown): Error {
  const reasons = reasonChain(err)
  const detail = reasons.length ? reasons.join(': ') : String(err)
  return new Error(`Request to ${what} failed: ${detail}`, { cause: err })
}

const MAX_DEPTH = 5

function reasonChain(err: unknown, depth = 0): string[] {
  if (err == null || depth >= MAX_DEPTH) {
    return []
  }
  if (!(err instanceof Error)) {
    return [String(err)]
  }

  const code = (err as { code?: unknown }).code
  const label = code ? `${err.message} (${String(code)})` : err.message

  const nested =
    err instanceof AggregateError && err.errors?.length
      ? err.errors.flatMap((inner) => reasonChain(inner, depth + 1))
      : reasonChain((err as { cause?: unknown }).cause, depth + 1)

  return [label, ...nested]
}
