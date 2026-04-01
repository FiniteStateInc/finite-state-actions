import * as core from '@actions/core'
import { FsClient, resolveProjectId, writeSetupContext } from '@finite-state/core'

export async function run(): Promise<void> {
  try {
    // ── Read inputs ──────────────────────────────────────────────────────────
    const apiToken = core.getInput('api-token', { required: true })
    const domain = core.getInput('domain') || 'app.finitestate.io'
    const projectIdInput = core.getInput('project-id') || undefined
    const projectNameInput = core.getInput('project-name') || undefined
    const versionId = core.getInput('version-id') || undefined

    if (projectIdInput && projectNameInput) {
      throw new Error('Provide either project-id or project-name, not both.')
    }

    // ── Validate auth ────────────────────────────────────────────────────────
    const client = new FsClient({ apiToken, domain })
    const authUser = await client.getAuthUser()

    core.info(`Authenticated as: ${authUser.email}`)
    core.info(`Organization ID: ${authUser.organizationId}`)

    // ── Resolve project ID ──────────────────────────────────────────────────
    let projectId: string | undefined
    if (projectIdInput) {
      projectId = projectIdInput
    } else if (projectNameInput) {
      projectId = await resolveProjectId(client, projectNameInput)
      core.info(`Resolved project name "${projectNameInput}" → ${projectId}`)
    }

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
