import * as core from '@actions/core'
import {
  FsClient,
  ProjectNotFoundError,
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

    // ── Install fs-cli, which doubles as the auth check ──────────────────────
    // The download endpoint is authenticated and 401/403 is non-retryable, so a
    // bad token or a domain from the wrong tenant fails here — in the first
    // step, before any downstream action runs.
    const client = new FsClient({ apiToken, domain })

    try {
      await installFsCli(client)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // Only an auth-shaped failure points at the token; a wrong runner
      // platform or a corrupt download must not be reported as a credential
      // problem.
      const looksLikeAuth = /\b(401|403|Unauthorized|Forbidden|token)\b/i.test(message)
      throw new Error(
        looksLikeAuth
          ? `Could not install fs-cli from ${domain}: ${message} — check that api-token is valid ` +
              `for ${domain}, which must be the tenant the token was issued from.`
          : `Could not install fs-cli from ${domain}: ${message}`,
      )
    }

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
