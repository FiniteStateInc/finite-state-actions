import * as core from '@actions/core'
import { readFileSync } from 'fs'
import { glob } from 'fs/promises'
import { basename } from 'path'
import {
  FsClient,
  ProjectNotFoundError,
  readSetupContext,
  resolveProjectId,
} from '@finite-state/core'
import type { ScanType, SbomFormat } from '@finite-state/core'

/**
 * Expands `pattern` when it looks like a glob. Requires exactly one match — a
 * Maven target/ directory happily matches sources and javadoc jars too, and
 * uploading those silently would be worse than failing here.
 */
async function resolveFile(pattern: string): Promise<string> {
  if (!/[*?[\]]/.test(pattern)) {
    return pattern
  }

  const matches: string[] = []
  for await (const match of glob(pattern)) {
    matches.push(match)
  }
  matches.sort()

  if (matches.length === 0) {
    throw new Error(`No file matches "${pattern}".`)
  }
  if (matches.length > 1) {
    throw new Error(
      `"${pattern}" matches ${matches.length} files: ${matches.join(', ')}. ` +
        `Narrow the pattern so it matches exactly one file.`,
    )
  }

  core.info(`Resolved "${pattern}" to ${matches[0]}`)
  return matches[0]
}

/**
 * Returns the project ID for `name`, creating the project when none exists.
 */
async function resolveOrCreateProject(
  client: FsClient,
  name: string,
  projectType: string,
): Promise<string> {
  try {
    return await resolveProjectId(client, name)
  } catch (err) {
    if (!(err instanceof ProjectNotFoundError)) {
      throw err
    }
    const project = await client.createProject(name, { projectType })
    core.info(`Created project "${name}" → ${project.id}`)
    return project.id
  }
}

export async function run(): Promise<void> {
  try {
    // ── Read inputs ──────────────────────────────────────────────────────────
    const types = core
      .getInput('type', { required: true })
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean) as ScanType[]
    const fileInput = core.getInput('file', { required: true })
    const projectIdOverride = core.getInput('project-id') || undefined
    const projectNameInput = core.getInput('project-name') || undefined
    const projectType = core.getInput('project-type') || 'firmware'
    const apiTokenOverride = core.getInput('api-token') || undefined
    const domainOverride = core.getInput('domain') || undefined
    const versionName = core.getInput('version') || undefined
    const versionIdInput = core.getInput('version-id') || undefined
    const scannerType = core.getInput('scanner-type') || undefined
    const sbomFormat = (core.getInput('sbom-format') || undefined) as SbomFormat | undefined
    const waitForCompletion = core.getBooleanInput('wait-for-completion')
    const timeoutSecs = parseInt(core.getInput('timeout') || '600', 10)

    // ── Read setup context, falling back to this action's own inputs ─────────
    // Running without the setup action is supported: pass api-token here.
    const ctx = readSetupContext({
      apiToken: apiTokenOverride,
      domain: domainOverride,
      projectId: projectIdOverride,
    })

    // Mask the token when it came from this action's input rather than setup.
    core.setSecret(ctx.apiToken)

    // ── Build client ─────────────────────────────────────────────────────────
    const client = new FsClient({ apiToken: ctx.apiToken, domain: ctx.domain })

    // ── Resolve project ──────────────────────────────────────────────────────
    const projectName = projectNameInput || ctx.projectName
    let projectId = ctx.projectId
    if (!projectId && projectName) {
      projectId = await resolveOrCreateProject(client, projectName, projectType)
    }

    // ── Resolve version ID ───────────────────────────────────────────────────
    let projectVersionId: string

    if (versionIdInput) {
      // Use existing version-id directly
      projectVersionId = versionIdInput
    } else if (versionName) {
      // Create a new version — projectId is required
      if (!projectId) {
        throw new Error(
          'A project is required when creating a new version. Provide project-id or ' +
            'project-name, or run finite-state/setup first.',
        )
      }
      const version = await client.createVersion(projectId, versionName)
      projectVersionId = version.id
    } else {
      throw new Error(
        'Either version (to create a new version) or version-id (to use an existing one) must be provided.',
      )
    }

    // ── Read file ────────────────────────────────────────────────────────────
    const file = await resolveFile(fileInput)
    const data = readFileSync(file)
    const filename = basename(file)

    // ── Upload one scan per requested type ───────────────────────────────────
    const scanIds: string[] = []
    for (const type of types) {
      const result = await client.uploadScan({
        type,
        filename,
        projectVersionId,
        data,
        scannerType,
        sbomFormat,
      })
      scanIds.push(result.id)
      core.info(`Uploaded ${filename} as ${type}: scan id=${result.id}`)
    }

    // ── Set outputs & env var ────────────────────────────────────────────────
    core.setOutput('scan-id', scanIds[0])
    core.setOutput('scan-ids', scanIds.join(','))
    core.setOutput('version-id', projectVersionId)
    core.exportVariable('FINITE_STATE_VERSION_ID', projectVersionId)

    core.info(`Uploaded ${scanIds.length} scan(s) to version ${projectVersionId}`)

    // ── Poll or submit ───────────────────────────────────────────────────────
    if (waitForCompletion) {
      const timeoutMs = timeoutSecs * 1000
      const scan = await client.pollScanCompletion(projectVersionId, timeoutMs, 15_000)
      core.setOutput('scan-status', scan.status)
      core.info(`Scan completed with status: ${scan.status}`)
    } else {
      core.setOutput('scan-status', 'SUBMITTED')
      core.info('Scan submitted. Polling skipped (wait-for-completion=false).')
    }
  } catch (err) {
    core.setFailed(err instanceof Error ? err.message : String(err))
  }
}

run()
