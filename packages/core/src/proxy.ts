import * as core from '@actions/core'
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici'

/**
 * The proxy variables undici's `EnvHttpProxyAgent` reads, in the order it
 * prefers them. Only used to name the one in the log line — the agent reads
 * them itself, along with `no_proxy`/`NO_PROXY`.
 */
const PROXY_VARS = ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY'] as const

let applied: string | undefined
let checked = false

/** Hides any credentials in a proxy URL before it reaches the log. */
function redact(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.username || parsed.password) {
      parsed.username = '***'
      parsed.password = ''
    }
    return parsed.toString()
  } catch {
    // Never echo a value we could not parse — it may be a malformed URL that
    // still carries a password.
    return '<unparseable>'
  }
}

/**
 * Routes this process's `fetch` calls through the proxy named in the
 * environment, and returns that proxy's URL (credentials removed) or undefined
 * when no proxy is configured.
 *
 * Node's global `fetch` ignores `HTTP_PROXY`/`HTTPS_PROXY` unless Node itself
 * was started with `NODE_USE_ENV_PROXY`, which an action cannot set for its own
 * process — so on a runner behind a proxy every platform request fails with a
 * bare `fetch failed`. Installing a proxy dispatcher here fixes that for both
 * the REST calls and the fs-cli download. fs-cli needs nothing: being a Go
 * binary, it reads the same variables on its own.
 *
 * Safe to call repeatedly; only the first call does anything.
 *
 * ponytail: undici is pinned to the major that matches the Node in each
 * action's `using:` (node24 -> undici 7). Moving the actions to a newer Node
 * runtime means bumping undici with it.
 */
export function useEnvProxy(): string | undefined {
  if (checked) {
    return applied
  }
  checked = true

  const variable = PROXY_VARS.find((name) => process.env[name])
  if (!variable) {
    return undefined
  }

  const redacted = redact(process.env[variable] as string)

  try {
    setGlobalDispatcher(new EnvHttpProxyAgent())
  } catch (err) {
    // A malformed proxy URL must not take down the step here — let the request
    // itself fail, with this warning to explain why.
    core.warning(
      `Ignoring ${variable} (${redacted}): ${err instanceof Error ? err.message : String(err)}`,
    )
    return undefined
  }

  applied = redacted
  core.info(`Routing Finite State requests through the proxy in ${variable} (${redacted})`)

  return applied
}
