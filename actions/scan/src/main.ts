import * as core from '@actions/core'
import * as exec from '@actions/exec'
import { readSetupContext } from '@finite-state/core'

export async function run(): Promise<void> {
  try {
    // ── Read inputs ──────────────────────────────────────────────────────────
    const dir = core.getInput('dir') || '.'
    const projectIdOverride = core.getInput('project-id') || undefined
    const version = core.getInput('version', { required: true })
    const name =
      core.getInput('name') || process.env.GITHUB_REPOSITORY?.split('/').pop() || undefined
    const extraArgs = core.getInput('extra-args') || undefined

    // ── Read setup context with overrides ────────────────────────────────────
    const ctx = readSetupContext({ projectId: projectIdOverride })

    if (!ctx.projectId && !name) {
      throw new Error(
        'Either project-id or name is required. Set project-id via the setup action or provide a name input.',
      )
    }

    // ── Build fs-cli args ────────────────────────────────────────────────────
    const args: string[] = [
      'scan',
      dir,
      '--token',
      ctx.apiToken,
      '--endpoint',
      `https://${ctx.domain}`,
      '--version',
      version,
    ]

    if (ctx.projectId) {
      args.push('--project-id', ctx.projectId)
    } else {
      args.push('--name', name!)
    }

    if (extraArgs) {
      const extra = extraArgs.split(/\s+/).filter(Boolean)
      args.push(...extra)
    }

    // ── Run fs-cli scan ──────────────────────────────────────────────────────
    core.info(`Scanning ${dir} for project ${ctx.projectId} version ${version}`)
    const exitCode = await exec.exec('fs-cli', args, {
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
