import * as core from '@actions/core'
import * as exec from '@actions/exec'
import { FsClient, ensureFsCli, readSetupContext, writeSetupContext } from '@finite-state/core'

/**
 * Pulls the platform's project and version IDs out of fs-cli's log output.
 *
 * fs-cli reports them three times over a successful scan, so both a completed
 * and an interrupted run have something to read:
 *
 *   msg="using project" name=WebGoat id=9b590756-...
 *   msg="using version" version=v1.2.3 id=a097b616-...
 *   msg="scan complete" ... submissionID=platform:9b590756-...:a097b616-...
 *
 * The submission ID carries both, so it is tried first.
 */
export function parseScanIds(output: string): { projectId?: string; versionId?: string } {
  const submission = /submissionID=platform:([^:\s]+):(\S+)/.exec(output)
  if (submission) {
    return { projectId: submission[1], versionId: submission[2] }
  }

  return {
    projectId: /msg="using project"[^\n]*?\bid=(\S+)/.exec(output)?.[1],
    versionId: /msg="using version"[^\n]*?\bid=(\S+)/.exec(output)?.[1],
  }
}

export async function run(): Promise<void> {
  try {
    // ── Read inputs ──────────────────────────────────────────────────────────
    const dir = core.getInput('dir') || '.'
    const projectIdOverride = core.getInput('project-id') || undefined
    const version = core.getInput('version', { required: true })
    const nameInput = core.getInput('name') || core.getInput('project-name') || undefined
    const apiTokenOverride = core.getInput('api-token') || undefined
    const domainOverride = core.getInput('domain') || undefined
    const extraArgs = core.getInput('extra-args') || undefined

    // ── Read setup context, falling back to this action's own inputs ─────────
    // Running without the setup action is supported: pass api-token here.
    const ctx = readSetupContext({
      apiToken: apiTokenOverride,
      domain: domainOverride,
      projectId: projectIdOverride,
    })

    // Mask the token when it came from this action's input rather than setup.
    core.setSecret(ctx.apiToken)

    // Prefer an explicit input, then the project name requested via setup, then
    // the repository name.
    const name = nameInput || ctx.projectName || process.env.GITHUB_REPOSITORY?.split('/').pop()

    if (!name) {
      throw new Error(
        'name is required. Set it via the name input or ensure GITHUB_REPOSITORY is available.',
      )
    }

    // ── Export the context for later steps ───────────────────────────────────
    // Written before the scan runs so a step with `if: always()` still has it.
    // No version ID: fs-cli takes a version *label*, and the platform's ID for
    // that version is not something this action learns — writing the label
    // under FINITE_STATE_VERSION_ID would send downstream actions after a
    // version that does not exist.
    writeSetupContext({
      apiToken: ctx.apiToken,
      domain: ctx.domain,
      projectId: ctx.projectId,
      projectName: name,
    })

    // ── Build fs-cli args ────────────────────────────────────────────────────
    // Flags first, scan target last — fs-cli expects the path as the final
    // positional argument.
    const args: string[] = [
      'scan',
      '--endpoint',
      `https://${ctx.domain}`,
      '--token',
      ctx.apiToken,
      '--name',
      name,
      '--version',
      version,
    ]

    if (ctx.projectId) {
      args.push('--project-id', ctx.projectId)
    }

    if (extraArgs) {
      const extra = extraArgs.split(/\s+/).filter(Boolean)
      args.push(...extra)
    }

    args.push(dir)

    // ── Ensure fs-cli is available ───────────────────────────────────────────
    // Installed by setup in the usual chained workflow; downloaded here when
    // scan runs standalone.
    const fsCli = await ensureFsCli(new FsClient({ apiToken: ctx.apiToken, domain: ctx.domain }))

    // ── Run fs-cli scan ──────────────────────────────────────────────────────
    core.info(`Scanning ${dir} for project ${ctx.projectId ?? name} version ${version}`)
    // fs-cli logs to stderr, and the IDs this action needs are in those log
    // lines — so both streams are captured. exec still echoes them to the
    // step log.
    let output = ''
    const collect = (data: Buffer) => {
      output += data.toString()
    }
    const exitCode = await exec.exec(fsCli, args, {
      ignoreReturnCode: true,
      listeners: { stdout: collect, stderr: collect },
    })

    core.setOutput('exit-code', String(exitCode))

    // ── Publish the IDs fs-cli resolved ─────────────────────────────────────
    // This is the only way scan learns them: it sends a version *label*, and
    // the platform decides which project and version that maps to. Downstream
    // actions such as download-sbom need the IDs, not the label.
    const scanned = parseScanIds(output)
    const resolvedProjectId = ctx.projectId || scanned.projectId

    if (resolvedProjectId) {
      core.setOutput('project-id', resolvedProjectId)
    }

    if (scanned.versionId) {
      core.setOutput('version-id', scanned.versionId)
    } else {
      core.warning(
        'Could not read the version ID from fs-cli output. Downstream actions that need one ' +
          '(such as download-sbom) will have to be given version-id explicitly.',
      )
    }

    writeSetupContext({
      apiToken: ctx.apiToken,
      domain: ctx.domain,
      projectId: resolvedProjectId,
      projectName: name,
      versionId: scanned.versionId,
    })

    if (exitCode !== 0) {
      core.setFailed(`fs-cli scan exited with code ${exitCode}`)
    }
  } catch (err) {
    core.setFailed(err instanceof Error ? err.message : String(err))
  }
}

run()
