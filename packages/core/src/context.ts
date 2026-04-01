import * as core from '@actions/core'
import type { SetupContext } from './models'

const ENV_KEYS = {
  apiToken: 'FINITE_STATE_AUTH_TOKEN',
  domain: 'FINITE_STATE_DOMAIN',
  projectId: 'FINITE_STATE_PROJECT_ID',
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
  if (ctx.versionId) {
    core.exportVariable(ENV_KEYS.versionId, ctx.versionId)
    core.setOutput('version-id', ctx.versionId)
  }
}

export function readSetupContext(overrides?: Partial<SetupContext>): SetupContext {
  const apiToken = overrides?.apiToken || process.env[ENV_KEYS.apiToken]
  if (!apiToken) {
    throw new Error(
      `${ENV_KEYS.apiToken} is not set. Run the finite-state/setup action first, or provide api-token as an input.`,
    )
  }

  const domain = overrides?.domain || process.env[ENV_KEYS.domain] || 'app.finitestate.io'
  const projectId = overrides?.projectId || process.env[ENV_KEYS.projectId] || undefined
  const versionId = overrides?.versionId || process.env[ENV_KEYS.versionId] || undefined

  return { apiToken, domain, projectId, versionId }
}
