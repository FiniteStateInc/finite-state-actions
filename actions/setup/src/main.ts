import * as core from '@actions/core'
import { FsClient, writeSetupContext } from '@finite-state/core'

export async function run(): Promise<void> {
  try {
    // ── Read inputs ──────────────────────────────────────────────────────────
    const apiToken = core.getInput('api-token', { required: true })
    const domain = core.getInput('domain') || 'app.finitestate.io'
    const projectId = core.getInput('project-id') || undefined
    const versionId = core.getInput('version-id') || undefined

    // ── Validate auth ────────────────────────────────────────────────────────
    const client = new FsClient({ apiToken, domain })
    const authUser = await client.getAuthUser()

    core.info(`Authenticated as: ${authUser.email}`)
    core.info(`Organization ID: ${authUser.organizationId}`)

    // ── Export context for downstream actions ────────────────────────────────
    writeSetupContext({ apiToken, domain, projectId, versionId })

    // ── Set outputs ──────────────────────────────────────────────────────────
    core.setOutput('user', authUser.email)
    core.setOutput('org-name', authUser.organizationId)

    if (projectId) {
      core.setOutput('project-id', projectId)
    }
    if (versionId) {
      core.setOutput('version-id', versionId)
    }
  } catch (err) {
    core.setFailed(err instanceof Error ? err.message : String(err))
  }
}

run()
