import * as core from '@actions/core'
import type { SetupContext } from './models'

const ENV_KEYS = {
  apiToken: 'FINITE_STATE_AUTH_TOKEN',
  domain: 'FINITE_STATE_DOMAIN',
  projectId: 'FINITE_STATE_PROJECT_ID',
  projectName: 'FINITE_STATE_PROJECT_NAME',
  versionId: 'FINITE_STATE_VERSION_ID',
} as const

export function writeSetupContext(ctx: SetupContext): void {
  core.setSecret(ctx.apiToken)
  core.exportVariable(ENV_KEYS.apiToken, ctx.apiToken)
  core.exportVariable(ENV_KEYS.domain, ctx.domain)

  if (ctx.projectId) {
    core.exportVariable(ENV_KEYS.projectId, ctx.projectId)
    core.setOutput('project-id', ctx.projectId)
  }
  if (ctx.projectName) {
    core.exportVariable(ENV_KEYS.projectName, ctx.projectName)
  }
  if (ctx.versionId) {
    core.exportVariable(ENV_KEYS.versionId, ctx.versionId)
    core.setOutput('version-id', ctx.versionId)
  }
}

/**
 * Trims a context value and treats a whitespace-only one as absent.
 *
 * `core.getInput` trims its own result, but an environment variable arrives
 * verbatim: a token assembled from a `vars.` value, or written by an earlier
 * step with a trailing newline, would otherwise be sent to the API as-is and
 * fail authentication, and a whitespace-only `FINITE_STATE_VERSION_ID` would
 * count as a version and be queried.
 */
function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

export function readSetupContext(overrides?: Partial<SetupContext>): SetupContext {
  const apiToken = clean(overrides?.apiToken) ?? clean(process.env[ENV_KEYS.apiToken])
  if (!apiToken) {
    throw new Error(
      `${ENV_KEYS.apiToken} is not set. Run the finite-state/setup action first, or provide api-token as an input.`,
    )
  }

  const domain =
    clean(overrides?.domain) ?? clean(process.env[ENV_KEYS.domain]) ?? 'app.finitestate.io'
  const projectId = clean(overrides?.projectId) ?? clean(process.env[ENV_KEYS.projectId])
  const projectName = clean(overrides?.projectName) ?? clean(process.env[ENV_KEYS.projectName])
  const versionId = clean(overrides?.versionId) ?? clean(process.env[ENV_KEYS.versionId])

  return { apiToken, domain, projectId, projectName, versionId }
}
