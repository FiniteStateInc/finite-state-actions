import * as core from '@actions/core'
import * as exec from '@actions/exec'
import { FsClient, ensureFsCli, readSetupContext } from '@finite-state/core'

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
    const exitCode = await exec.exec(fsCli, args, {
      ignoreReturnCode: true,
    })

    core.setOutput('exit-code', String(exitCode))

    if (exitCode !== 0) {
      core.setFailed(`fs-cli scan exited with code ${exitCode}`)
    }
  } catch (err) {
    core.setFailed(err instanceof Error ? err.message : String(err))
  }
}

run()
