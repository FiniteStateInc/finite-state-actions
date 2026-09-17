import * as core from '@actions/core'
import * as exec from '@actions/exec'
import { FsClient, ensureFsCli, parseTimeoutMinutes, readSetupContext } from '@finite-state/core'

export async function run(): Promise<void> {
  try {
    // ── Read inputs ──────────────────────────────────────────────────────────
    const apiTokenOverride = core.getInput('api-token') || undefined
    const domainOverride = core.getInput('domain') || undefined
    const versionIdInput = core.getInput('version-id') || undefined
    // Unset leaves fs-cli its own 30-minute default.
    const timeoutMinutes = parseTimeoutMinutes(core.getInput('timeout'))

    // ── Read setup context, falling back to this action's own inputs ─────────
    // Running without setup, scan or upload is supported: pass api-token here.
    const ctx = readSetupContext({
      apiToken: apiTokenOverride,
      domain: domainOverride,
      versionId: versionIdInput,
    })

    // Masks a token that came from this action's input rather than setup, where
    // it is masked already.
    core.setSecret(ctx.apiToken)

    if (!ctx.versionId) {
      throw new Error(
        'No version to wait on. Run scan or upload first, or pass version-id. It is the ' +
          "platform's version ID, not a label like v1.2.3.",
      )
    }

    // Reuses an fs-cli that setup, scan or upload already put on PATH and
    // downloads one only when this is the first Finite State step in the job.
    const fsCli = await ensureFsCli(new FsClient({ apiToken: ctx.apiToken, domain: ctx.domain }))

    core.info(`Waiting for scans on version ${ctx.versionId} to finish.`)

    // --wait polls; --fail-on-scan-incomplete fails the step on a failed scan,
    // a poll timeout, or a version with no scans at all, so a later step never
    // reads partial results from a green job.
    //
    // fs-cli's exit code is the verdict, which is what upload treats as
    // authoritative too. upload additionally parses the JSON rollup only
    // because it publishes a scan-status output that must not contradict the
    // exit code; this action has no such output and so has nothing to parse.
    //
    // The token goes through FS_TOKEN so it stays out of the argument list.
    const exitCode = await exec.exec(
      fsCli,
      [
        'query',
        '--type',
        'scan',
        '--format',
        'json',
        '--endpoint',
        `https://${ctx.domain}`,
        '--version-id',
        ctx.versionId,
        '--wait',
        ...(timeoutMinutes ? ['--poll-timeout', String(timeoutMinutes)] : []),
        '--fail-on-scan-incomplete',
      ],
      {
        ignoreReturnCode: true,
        env: { ...process.env, FS_TOKEN: ctx.apiToken } as Record<string, string>,
      },
    )

    if (exitCode !== 0) {
      // fs-cli has already printed why; this adds the context a bare non-zero
      // exit does not carry.
      throw new Error(
        `fs-cli query exited ${exitCode} for version ${ctx.versionId} on ${ctx.domain}. ` +
          `The scan failed, ran past the poll timeout, or the version has no scans. ` +
          `See the fs-cli output above.`,
      )
    }

    core.info(`Scans on version ${ctx.versionId} finished.`)
  } catch (err) {
    core.setFailed(err instanceof Error ? err.message : String(err))
  }
}

run()
