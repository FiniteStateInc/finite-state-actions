import * as core from '@actions/core'
import {
  FsClient,
  ProjectNotFoundError,
  authUserIdentity,
  authUserOrganization,
  installFsCli,
  resolveProjectId,
  writeSetupContext,
} from '@finite-state/core'

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

    const identity = authUserIdentity(authUser)
    const organization = authUserOrganization(authUser)

    if (!identity) {
      core.warning(
        'The platform accepted the token but returned an unrecognized /authUser response. ' +
          'Check that the domain matches the tenant the token was issued from.',
      )
    }
    core.info(`Authenticated as: ${identity ?? 'unknown'}`)
    core.info(`Organization: ${organization ?? 'unknown'}`)

    // ── Install fs-cli ───────────────────────────────────────────────────────
    await installFsCli(client)

    // ── Resolve project ID ──────────────────────────────────────────────────
    let projectId: string | undefined
    if (projectIdInput) {
      projectId = projectIdInput
    } else if (projectNameInput) {
      try {
        projectId = await resolveProjectId(client, projectNameInput)
        core.info(`Resolved project name "${projectNameInput}" → ${projectId}`)
      } catch (err) {
        // An unknown name is not fatal: fs-cli creates the project on the next
        // scan/upload. An ambiguous name still is — we cannot guess which one.
        if (!(err instanceof ProjectNotFoundError)) {
          throw err
        }
        core.warning(
          `No existing project named "${projectNameInput}". Continuing without a project ID — ` +
            `fs-cli will create it on the next scan or upload.`,
        )
      }
    }

    // ── Export context for downstream actions ────────────────────────────────
    writeSetupContext({ apiToken, domain, projectId, projectName: projectNameInput, versionId })

    // ── Set outputs ──────────────────────────────────────────────────────────
    core.setOutput('user', identity ?? '')
    core.setOutput('org-name', organization ?? '')

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
