import * as core from '@actions/core'
import * as exec from '@actions/exec'
import {
  FsClient,
  ensureFsCli,
  quoteExecPath,
  readSetupContext,
  timeoutSecondsToMinutes,
} from '@finite-state/core'

/**
 * A failure this action raises itself, carrying the annotation title the shell
 * version used and the code to exit with.
 *
 * The titles are the ones `wait.sh` wrote, so a log filter or dashboard keyed
 * on `title=No version ID` keeps matching. `exitCode` is fs-cli's own for a
 * scan that did not finish, which the shell version passed through with
 * `exit "$QUERY_EXIT"`.
 */
class WaitFailure extends Error {
  constructor(
    message: string,
    readonly title: string,
    readonly exitCode = 1,
  ) {
    super(message)
  }
}

/**
 * Runs `read`, re-raising whatever it throws under `title`. Awaits, so an
 * async `read` rejecting is titled too rather than slipping past as a plain
 * error.
 */
async function titled<T>(title: string, read: () => T | Promise<T>): Promise<T> {
  try {
    return await read()
  } catch (err) {
    throw new WaitFailure(err instanceof Error ? err.message : String(err), title)
  }
}

export async function run(): Promise<void> {
  try {
    // ── Read inputs ──────────────────────────────────────────────────────────
    const apiTokenOverride = core.getInput('api-token') || undefined
    const domainOverride = core.getInput('domain') || undefined
    const versionIdInput = core.getInput('version-id') || undefined

    // ── Read setup context, falling back to this action's own inputs ─────────
    // Running without setup, scan or upload is supported: pass api-token here.
    // Read before the timeout is parsed so a job missing its token fails on
    // the token, not on whichever other input also happens to be wrong.
    const ctx = await titled('No API token', () =>
      readSetupContext({
        apiToken: apiTokenOverride,
        domain: domainOverride,
        versionId: versionIdInput,
      }),
    )

    // Masks a token that came from this action's input rather than setup, where
    // it is masked already. First thing after the read, so nothing below can
    // log it unmasked.
    core.setSecret(ctx.apiToken)

    if (!ctx.versionId) {
      throw new WaitFailure(
        'No version to wait on. Run scan or upload first, or pass version-id. It is the ' +
          "platform's version ID, not a label like v1.2.3.",
        'No version ID',
      )
    }

    // Unset leaves fs-cli its own 30-minute default.
    const timeout = await titled('Bad timeout', () =>
      timeoutSecondsToMinutes(core.getInput('timeout')),
    )
    if (timeout.warning) {
      core.warning(timeout.warning, { title: 'Timeout rounded' })
    }

    // Reuses an fs-cli that setup, scan or upload already put on PATH and
    // downloads one only when this is the first Finite State step in the job.
    const fsCli = await titled('fs-cli not found', () =>
      ensureFsCli(new FsClient({ apiToken: ctx.apiToken, domain: ctx.domain })),
    )

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
    // The token goes through FS_TOKEN so it stays out of the argument list, and
    // the path is quoted because exec splits its first parameter on spaces.
    const exitCode = await exec.exec(
      quoteExecPath(fsCli),
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
        ...(timeout.minutes ? ['--poll-timeout', String(timeout.minutes)] : []),
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
      throw new WaitFailure(
        `fs-cli query exited ${exitCode} for version ${ctx.versionId} on ${ctx.domain}. ` +
          `The scan failed, ran past the poll timeout, or the version has no scans. ` +
          `See the fs-cli output above.`,
        'Scan did not finish',
        exitCode,
      )
    }

    core.info(`Scans on version ${ctx.versionId} finished.`)
  } catch (err) {
    if (err instanceof WaitFailure) {
      // core.setFailed would drop the title and force exit 1. Both are what the
      // shell version published, so both are kept.
      core.error(err.message, { title: err.title })
      process.exitCode = err.exitCode
      return
    }

    core.setFailed(err instanceof Error ? err.message : String(err))
  }
}

run()
