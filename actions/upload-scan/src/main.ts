import * as core from '@actions/core'
import { readFileSync } from 'fs'
import { basename } from 'path'
import { FsClient, readSetupContext } from '@finite-state/core'
import type { ScanType, SbomFormat } from '@finite-state/core'

export async function run(): Promise<void> {
  try {
    // ── Read inputs ──────────────────────────────────────────────────────────
    const type = core.getInput('type', { required: true }) as ScanType
    const file = core.getInput('file', { required: true })
    const projectIdOverride = core.getInput('project-id') || undefined
    const versionName = core.getInput('version') || undefined
    const versionIdInput = core.getInput('version-id') || undefined
    const scannerType = core.getInput('scanner-type') || undefined
    const sbomFormat = (core.getInput('sbom-format') || undefined) as SbomFormat | undefined
    const waitForCompletion = core.getBooleanInput('wait-for-completion')
    const timeoutSecs = parseInt(core.getInput('timeout') || '600', 10)

    // ── Read setup context with overrides ────────────────────────────────────
    const ctx = readSetupContext({ projectId: projectIdOverride })

    // ── Build client ─────────────────────────────────────────────────────────
    const client = new FsClient({ apiToken: ctx.apiToken, domain: ctx.domain })

    // ── Resolve version ID ───────────────────────────────────────────────────
    let projectVersionId: string

    if (versionIdInput) {
      // Use existing version-id directly
      projectVersionId = versionIdInput
    } else if (versionName) {
      // Create a new version — projectId is required
      if (!ctx.projectId) {
        throw new Error(
          'project-id is required when creating a new version. ' +
            'Provide it as an input or run finite-state/setup first.',
        )
      }
      const version = await client.createVersion(ctx.projectId, versionName)
      projectVersionId = version.id
    } else {
      throw new Error(
        'Either version (to create a new version) or version-id (to use an existing one) must be provided.',
      )
    }

    // ── Read file ────────────────────────────────────────────────────────────
    const data = readFileSync(file)
    const filename = basename(file)

    // ── Upload scan ──────────────────────────────────────────────────────────
    const result = await client.uploadScan({
      type,
      filename,
      projectVersionId,
      data,
      scannerType,
      sbomFormat,
    })

    const scanId = result.id

    // ── Set outputs & env var ────────────────────────────────────────────────
    core.setOutput('scan-id', scanId)
    core.setOutput('version-id', projectVersionId)
    core.exportVariable('FINITE_STATE_VERSION_ID', projectVersionId)

    core.info(`Scan uploaded: id=${scanId}, versionId=${projectVersionId}`)

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
