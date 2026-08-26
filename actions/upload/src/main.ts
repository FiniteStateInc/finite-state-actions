import * as core from '@actions/core'
import * as exec from '@actions/exec'
import { glob } from 'fs/promises'
import { FsClient, ensureFsCli, readSetupContext } from '@finite-state/core'
import type { SbomFormat } from '@finite-state/core'

// ── Scan-type routing ─────────────────────────────────────────────────────────

/** Types fs-cli's `upload` subcommand handles, in its own naming. */
const BINARY_TYPES = new Set(['sca', 'sast', 'config', 'vulnerability_analysis'])

/** SBOM formats fs-cli accepts, keyed by the aliases this action documents. */
const SBOM_FORMATS: Record<string, string> = {
  cdx: 'cyclonedx',
  cyclonedx: 'cyclonedx',
  spdx: 'spdx',
}

/**
 * Maps the `sbom-format` input to fs-cli's `--format`, or to nothing at all when
 * it was not set — fs-cli then detects the format from the file's contents.
 */
function sbomFormatArgs(sbomFormat?: SbomFormat): string[] {
  if (!sbomFormat) {
    return []
  }
  const format = SBOM_FORMATS[sbomFormat.trim().toLowerCase()]
  if (!format) {
    throw new Error(
      `sbom-format "${sbomFormat}" is not recognized. Valid: cdx (cyclonedx) or spdx. ` +
        `Leave it unset to let fs-cli detect the format.`,
    )
  }
  return ['--format', format]
}

/** Our inputs use hyphens; fs-cli uses underscores. */
function normalizeType(type: string): string {
  return type.trim().replace(/-/g, '_')
}

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

// ── fs-cli invocation ─────────────────────────────────────────────────────────

interface FsCliRun {
  exitCode: number
  stdout: string
}

/**
 * Runs fs-cli, capturing stdout. The token goes through FS_TOKEN rather than
 * `--token` so it never lands in the process argument list.
 */
async function runFsCli(binary: string, args: string[], token: string): Promise<FsCliRun> {
  let stdout = ''

  const exitCode = await exec.exec(binary, args, {
    ignoreReturnCode: true,
    env: { ...process.env, FS_TOKEN: token } as Record<string, string>,
    listeners: {
      stdout: (data: Buffer) => {
        stdout += data.toString()
      },
    },
  })

  return { exitCode, stdout }
}

/**
 * Pulls the IDs out of fs-cli's completion line — `upload`/`third-party` print
 * `upload complete: project=<id> version=<id>`, `import` prints
 * `Imported SBOM: project=<id> version=<id>`.
 */
function parseUploadIds(stdout: string): { projectId?: string; versionId?: string } {
  const match = /project=(\S+)\s+version=(\S+)/.exec(stdout)
  return match ? { projectId: match[1], versionId: match[2] } : {}
}

/**
 * Extracts a JSON object from output that may carry log lines around it.
 *
 * Each `{` is tried as a start and the matching close brace is found by
 * counting depth (string literals and escapes skipped), so a brace inside a log
 * line cannot splice two fragments into a parseable but wrong object.
 */
function parseJsonBlock<T>(stdout: string): T | undefined {
  for (let start = stdout.indexOf('{'); start !== -1; start = stdout.indexOf('{', start + 1)) {
    const end = findObjectEnd(stdout, start)
    if (end === -1) {
      continue
    }
    try {
      return JSON.parse(stdout.slice(start, end + 1)) as T
    } catch {
      // Not a JSON object after all — try the next candidate start.
    }
  }
  return undefined
}

/** Index of the `}` closing the object that opens at `start`, or -1. */
function findObjectEnd(text: string, start: number): number {
  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < text.length; i++) {
    const char = text[i]

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
    } else if (char === '{') {
      depth++
    } else if (char === '}') {
      depth--
      if (depth === 0) {
        return i
      }
    }
  }

  return -1
}

/** Shape of `fs-cli query --type scan --format json`. */
interface ScanQueryResult {
  projectVersionId: string
  found: boolean
  tests?: {
    totalTests: number
    completedTests: number
    failedTests: number
    testTypes?: { id: string; name: string; status: string }[]
  }
}

/**
 * Rolls the per-type scan summary up into one status for the `scan-status`
 * output.
 */
function summarizeStatus(result: ScanQueryResult | undefined): string | undefined {
  // No result at all means the output was unreadable, which is not the same as
  // the platform reporting no scans.
  if (!result) {
    return undefined
  }
  if (!result.found || !result.tests) {
    return 'NOT_FOUND'
  }

  const tests = result.tests

  const { totalTests, completedTests, failedTests } = tests
  // Counts that are absent or not numbers make the rollup unusable — say so
  // rather than letting NaN comparisons fall through to a confident RUNNING.
  if (![totalTests, completedTests, failedTests].every((n) => Number.isFinite(n))) {
    return undefined
  }
  if (totalTests === 0) {
    return 'NOT_FOUND'
  }
  if (failedTests > 0) {
    return 'FAILED'
  }
  return completedTests + failedTests >= totalTests ? 'COMPLETED' : 'RUNNING'
}

/**
 * Builds the fs-cli argument list for the requested scan types. Binary types
 * go through `upload` (one invocation covers a comma-separated list); SBOMs
 * through `import`; external scanner output through `third-party`.
 */
function buildFsCliArgs(opts: {
  types: string[]
  file: string
  locator: string[]
  scannerType?: string
  sbomFormat?: SbomFormat
  timeoutMinutes?: number
}): string[] {
  const { types, file, locator } = opts

  // Omitted when the caller set no timeout, leaving fs-cli its own default.
  const timeout = opts.timeoutMinutes ? ['--timeout', String(opts.timeoutMinutes)] : []

  if (types.length === 0) {
    throw new Error(
      'type is empty. Provide at least one of: sca, sast, config, vulnerability-analysis, ' +
        'sbom, third-party.',
    )
  }

  const binary = types.filter((t) => BINARY_TYPES.has(t))
  const special = types.filter((t) => !BINARY_TYPES.has(t))

  if (binary.length && special.length) {
    throw new Error(
      `type mixes binary scan types (${binary.join(',')}) with ${special.join(',')}, which use ` +
        `different upload paths. Use one upload step per group.`,
    )
  }

  if (special.length > 1) {
    throw new Error(`type "${special.join(',')}" cannot be combined. Use one upload step per type.`)
  }

  if (special.length === 1) {
    const type = special[0]
    if (type === 'sbom') {
      // fs-cli auto-detects the format from the file when --format is omitted,
      // so only pass it when the caller actually asked for one. `import` has no
      // --timeout of its own.
      return ['import', file, ...locator, ...sbomFormatArgs(opts.sbomFormat)]
    }
    if (type === 'third_party') {
      if (!opts.scannerType) {
        throw new Error('scanner-type is required when type is third-party.')
      }
      return ['third-party', file, ...locator, '--type', opts.scannerType, ...timeout]
    }
    throw new Error(
      `Unknown scan type "${type}". Valid: sca, sast, config, vulnerability-analysis, sbom, ` +
        `third-party.`,
    )
  }

  // One fs-cli upload covers every binary type in a comma-separated list.
  return ['upload', file, ...locator, '--type', binary.join(','), ...timeout]
}

export async function run(): Promise<void> {
  try {
    // ── Read inputs ──────────────────────────────────────────────────────────
    const types = core
      .getInput('type', { required: true })
      .split(',')
      .map(normalizeType)
      .filter(Boolean)
    const fileInput = core.getInput('file', { required: true })
    const projectIdOverride = core.getInput('project-id') || undefined
    const projectNameInput = core.getInput('project-name') || undefined
    const apiTokenOverride = core.getInput('api-token') || undefined
    const domainOverride = core.getInput('domain') || undefined
    const versionName = core.getInput('version') || undefined
    const versionIdInput = core.getInput('version-id') || undefined
    const scannerType = core.getInput('scanner-type') || undefined
    const sbomFormat = (core.getInput('sbom-format') || undefined) as SbomFormat | undefined
    const waitForCompletion = core.getBooleanInput('wait-for-completion')

    // timeout is optional: unset means fs-cli's own defaults (30 minutes for
    // the upload, 30 for the scan poll) rather than a bound we invented.
    const timeoutInput = core.getInput('timeout').trim()
    // Deliberately strict: parseInt would read "600s" as 600 and "10 minutes"
    // as 10, quietly applying a bound the caller did not ask for.
    if (timeoutInput && !/^\d+$/.test(timeoutInput)) {
      throw new Error(
        `timeout must be a whole number of seconds, got "${timeoutInput}". ` +
          `Leave it unset to use fs-cli's own defaults.`,
      )
    }
    const timeoutSecs = timeoutInput ? parseInt(timeoutInput, 10) : undefined
    if (timeoutSecs !== undefined && timeoutSecs <= 0) {
      throw new Error(`timeout must be a positive number of seconds, got "${timeoutInput}".`)
    }
    const timeoutMinutes = timeoutSecs ? Math.max(1, Math.ceil(timeoutSecs / 60)) : undefined
    // fs-cli takes whole minutes, so any timeout that is not an exact multiple
    // of 60 rounds up — warn with the bound that will actually apply rather
    // than waiting longer than asked without saying so.
    if (timeoutSecs !== undefined && timeoutMinutes !== undefined && timeoutSecs % 60 !== 0) {
      core.warning(
        `timeout ${timeoutSecs}s is not a whole number of minutes, which is all fs-cli accepts; ` +
          `rounding up to ${timeoutMinutes} minute(s).`,
      )
    }

    if (core.getInput('project-type')) {
      core.warning(
        'project-type is ignored: fs-cli creates the project, and the platform picks the type.',
      )
    }

    // ── Read setup context, falling back to this action's own inputs ─────────
    // Running without the setup action is supported: pass api-token here.
    const ctx = readSetupContext({
      apiToken: apiTokenOverride,
      domain: domainOverride,
      projectId: projectIdOverride,
    })

    // Mask the token when it came from this action's input rather than setup.
    core.setSecret(ctx.apiToken)

    const projectName = projectNameInput || ctx.projectName

    if (!ctx.projectId && !projectName && !versionIdInput) {
      throw new Error(
        'A project is required. Provide project-id or project-name, or run finite-state/setup first.',
      )
    }
    if (!versionName && !versionIdInput) {
      throw new Error(
        'Either version (to create a new version) or version-id (to use an existing one) must be provided.',
      )
    }

    // ── Build the project/version locator ────────────────────────────────────
    // fs-cli find-or-creates the project and version itself, so this action
    // makes no API calls of its own beyond fetching the CLI. --name is passed
    // even alongside --project-id because fs-cli validates it before deciding
    // the ID makes it redundant.
    const endpoint = `https://${ctx.domain}`
    // fs-cli requires --name even when --project-id makes it redundant for
    // resolution (config.go: `if c.Name == "" { return "--name is required" }`),
    // so fall back to the repository name the way the scan action does. The
    // project ID is never used here: if a future fs-cli stops ignoring --name
    // under --project-id, it would find-or-create a project literally named
    // after the ID.
    const name = projectName || process.env.GITHUB_REPOSITORY?.split('/').pop()
    if (!name) {
      throw new Error(
        'A project name is required: fs-cli needs --name even when project-id is set. ' +
          'Provide project-name, run finite-state/setup with project-name, or ensure ' +
          'GITHUB_REPOSITORY is available.',
      )
    }
    const locator = [
      '--endpoint',
      endpoint,
      '--name',
      name,
      ...(versionName ? ['--version', versionName] : []),
      ...(ctx.projectId ? ['--project-id', ctx.projectId] : []),
      ...(versionIdInput ? ['--version-id', versionIdInput] : []),
    ]

    const file = await resolveFile(fileInput)
    const fsCli = await ensureFsCli(new FsClient({ apiToken: ctx.apiToken, domain: ctx.domain }))

    const args = buildFsCliArgs({
      types,
      file,
      locator,
      scannerType,
      sbomFormat,
      timeoutMinutes,
    })

    // ── Upload through fs-cli ────────────────────────────────────────────────
    core.info(`Uploading ${file} (${types.join(',')}) via fs-cli ${args[0]}`)
    const upload = await runFsCli(fsCli, args, ctx.apiToken)

    if (upload.exitCode !== 0) {
      throw new Error(`fs-cli ${args[0]} exited with code ${upload.exitCode}`)
    }

    const projectVersionId = versionIdInput || parseUploadIds(upload.stdout).versionId
    if (!projectVersionId) {
      throw new Error(
        `Could not read the version ID from fs-cli ${args[0]} output. ` +
          `Pass version-id to bind the upload to a known version.`,
      )
    }

    core.setOutput('version-id', projectVersionId)
    core.exportVariable('FINITE_STATE_VERSION_ID', projectVersionId)

    if (!waitForCompletion) {
      core.setOutput('scan-status', 'SUBMITTED')
      core.info('Upload complete. Polling skipped (wait-for-completion=false).')
      return
    }

    // ── Wait for the scans via fs-cli query ──────────────────────────────────
    // --fail-on-scan-incomplete keeps the old API-polling semantics: a poll
    // timeout, a failed scan, or a version with no scans at all fails the step.
    const query = await runFsCli(
      fsCli,
      [
        'query',
        '--type',
        'scan',
        '--format',
        'json',
        '--endpoint',
        endpoint,
        '--version-id',
        projectVersionId,
        '--wait',
        ...(timeoutMinutes ? ['--poll-timeout', String(timeoutMinutes)] : []),
        '--fail-on-scan-incomplete',
      ],
      ctx.apiToken,
    )

    const result = parseJsonBlock<ScanQueryResult>(query.stdout)

    const rollup = summarizeStatus(result)

    if (query.exitCode !== 0) {
      // fs-cli already printed why (scans failed, still running, or none
      // found); surface it as a step failure, as the API polling path did.
      const status = rollup ?? 'UNKNOWN'
      core.setOutput('scan-status', status)
      throw new Error(
        `fs-cli query reported scan status ${status} (exit code ${query.exitCode}) for version ${projectVersionId}.`,
      )
    }

    // Exit 0 under --fail-on-scan-incomplete means every scan for the version
    // settled successfully, so the exit code decides the outcome. Output we
    // could not read must not report as NOT_FOUND.
    if (rollup === undefined) {
      core.warning(
        'fs-cli query exited 0 but its output could not be read; reporting COMPLETED from the ' +
          'exit code.',
      )
    }

    const status = rollup ?? 'COMPLETED'
    core.setOutput('scan-status', status)

    // A clean exit that disagrees with its own rollup means one of the two is
    // wrong; failing is the only safe reading, since passing would publish
    // FAILED or RUNNING from a green step.
    if (rollup !== undefined && rollup !== 'COMPLETED') {
      throw new Error(
        `fs-cli query exited 0 but reported scan status ${rollup} for version ` +
          `${projectVersionId}. Refusing to report success.`,
      )
    }

    core.info(`Scan completed with status: ${status}`)
  } catch (err) {
    core.setFailed(err instanceof Error ? err.message : String(err))
  }
}

run()
