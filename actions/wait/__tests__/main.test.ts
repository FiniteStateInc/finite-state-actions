import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock @actions/exec ─────────────────────────────────────────────────────────

const execCalls: { binary: string; args: string[]; options: Record<string, unknown> }[] = []
let exitCode = 0

const mockExec = vi.fn(
  async (binary: string, args: string[], options: Record<string, unknown> = {}) => {
    execCalls.push({ binary, args, options })
    return exitCode
  },
)

vi.mock('@actions/exec', () => ({
  exec: (...args: unknown[]) => mockExec(...(args as [string, string[], Record<string, unknown>])),
}))

// ── Mock @actions/core ─────────────────────────────────────────────────────────

vi.mock('@actions/core', () => ({
  getInput: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  setFailed: vi.fn(),
  setSecret: vi.fn(),
  info: vi.fn(),
}))

// ── Mock @finite-state/core ────────────────────────────────────────────────────
//
// timeoutSecondsToMinutes and quoteExecPath are the real ones, imported from
// source rather than from the package's built dist so this suite does not need
// a core build. timeoutSecondsToMinutes is the whole of this action's input
// validation and quoteExecPath decides what exec is actually handed, so
// stubbing either would leave the rounding, the rejections, and the path
// assertions below asserting nothing.

const mockEnsureFsCli = vi.fn()

vi.mock('@finite-state/core', async () => {
  const { timeoutSecondsToMinutes } = await import('../../../packages/core/src/timeout')
  const { quoteExecPath } = await import('../../../packages/core/src/exec-path')
  return {
    FsClient: vi.fn().mockImplementation(() => ({})),
    ensureFsCli: (...args: unknown[]) => mockEnsureFsCli(...args),
    readSetupContext: vi.fn(),
    timeoutSecondsToMinutes,
    quoteExecPath,
  }
})

// ── Imports (after mocks) ──────────────────────────────────────────────────────

import * as core from '@actions/core'
import { readSetupContext } from '@finite-state/core'
import { run } from '../src/main'

// ── Helpers ────────────────────────────────────────────────────────────────────

function setInputs(inputs: Record<string, string>): void {
  vi.mocked(core.getInput).mockImplementation((name: string) => inputs[name] ?? '')
}

/** The single fs-cli call this action makes. */
function queryCall() {
  expect(execCalls).toHaveLength(1)
  return execCalls[0]
}

/**
 * The quoted command line this action built. `spawn.test.ts` covers the other
 * half of the property — that a quoted path with a space in it really does
 * reach a spawned process — by running one.
 */
function commandLine() {
  return queryCall().binary
}

/**
 * `--poll-timeout` and the argument that follows it, so a value landing
 * somewhere else in the list is not mistaken for one that follows the flag.
 */
function pollTimeoutFlag() {
  const args = queryCall().args
  const at = args.indexOf('--poll-timeout')
  expect(at).toBeGreaterThanOrEqual(0)
  return args.slice(at, at + 2)
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('wait action', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    execCalls.length = 0
    exitCode = 0
    process.exitCode = undefined

    vi.mocked(readSetupContext).mockReturnValue({
      apiToken: 'test-token',
      domain: 'app.finitestate.io',
      projectId: '42',
      versionId: 'ver-999',
    })

    setInputs({})
    mockEnsureFsCli.mockResolvedValue('/usr/local/bin/fs-cli')
  })

  it('waits on the version from the setup context', async () => {
    await run()

    const query = queryCall()
    expect(commandLine()).toBe('"/usr/local/bin/fs-cli"')
    expect(query.args).toEqual([
      'query',
      '--type',
      'scan',
      '--format',
      'json',
      '--endpoint',
      'https://app.finitestate.io',
      '--version-id',
      'ver-999',
      '--wait',
      '--fail-on-scan-incomplete',
    ])
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('passes its own inputs through to the context', async () => {
    setInputs({ 'api-token': 'input-token', domain: 'eu.finitestate.io', 'version-id': 'ver-1' })

    await run()

    expect(readSetupContext).toHaveBeenCalledWith({
      apiToken: 'input-token',
      domain: 'eu.finitestate.io',
      versionId: 'ver-1',
    })
  })

  it('masks the token and keeps it out of the argument list', async () => {
    await run()

    const query = queryCall()
    expect(core.setSecret).toHaveBeenCalledWith('test-token')
    expect(query.args).not.toContain('--token')
    expect(query.args.join(' ')).not.toContain('test-token')
    expect((query.options.env as Record<string, string>).FS_TOKEN).toBe('test-token')
  })

  it('fails without ever calling fs-cli when no version is known', async () => {
    vi.mocked(readSetupContext).mockReturnValue({
      apiToken: 'test-token',
      domain: 'app.finitestate.io',
      versionId: undefined,
    })

    await run()

    expect(execCalls).toHaveLength(0)
    // The title wait.sh wrote, kept so a log filter keyed on it still matches.
    expect(core.error).toHaveBeenCalledWith(expect.stringContaining('No version to wait on'), {
      title: 'No version ID',
    })
    expect(process.exitCode).toBe(1)
  })

  it('fails with the exit code, version and domain when fs-cli does not settle', async () => {
    exitCode = 3

    await run()

    expect(core.error).toHaveBeenCalledWith(
      expect.stringContaining('fs-cli query exited 3 for version ver-999 on app.finitestate.io'),
      { title: 'Scan did not finish' },
    )
  })

  it('exits with fs-cli\'s own code, as the shell version\'s exit "$QUERY_EXIT" did', async () => {
    exitCode = 7

    await run()

    // core.setFailed would force 1 and lose the distinction between a failed
    // scan and a poll timeout.
    expect(process.exitCode).toBe(7)
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('reports a missing token through the context error', async () => {
    vi.mocked(readSetupContext).mockImplementation(() => {
      throw new Error('FINITE_STATE_AUTH_TOKEN is not set.')
    })

    await run()

    expect(execCalls).toHaveLength(0)
    expect(core.error).toHaveBeenCalledWith(
      expect.stringContaining('FINITE_STATE_AUTH_TOKEN is not set.'),
      { title: 'No API token' },
    )
    expect(process.exitCode).toBe(1)
  })

  it('reads the context before parsing the timeout, so a missing token is reported first', async () => {
    vi.mocked(readSetupContext).mockImplementation(() => {
      throw new Error('FINITE_STATE_AUTH_TOKEN is not set.')
    })
    setInputs({ timeout: 'not-a-number' })

    await run()

    // Both inputs are wrong. The token is the one to fix first, so it is the
    // one reported — the ordering wait.sh had.
    expect(core.error).toHaveBeenCalledWith(expect.any(String), { title: 'No API token' })
    expect(core.error).not.toHaveBeenCalledWith(expect.any(String), { title: 'Bad timeout' })
  })

  it('masks the token before anything else can fail and log it', async () => {
    setInputs({ timeout: 'not-a-number' })

    await run()

    expect(core.setSecret).toHaveBeenCalledWith('test-token')
    expect(core.error).toHaveBeenCalledWith(expect.any(String), { title: 'Bad timeout' })
  })

  // ── timeout ──────────────────────────────────────────────────────────────────

  it('omits --poll-timeout when no timeout is given', async () => {
    await run()

    expect(queryCall().args).not.toContain('--poll-timeout')
  })

  it('converts a whole-minute timeout without warning', async () => {
    setInputs({ timeout: '600' })

    await run()

    expect(pollTimeoutFlag()).toEqual(['--poll-timeout', '10'])
    expect(core.warning).not.toHaveBeenCalled()
  })

  it.each([
    ['90', '2'],
    ['30', '1'],
    // A leading zero is base 10 here. The bash version this action replaced
    // read "0600" as octal 384, and aborted outright on "09".
    ['0600', '10'],
  ])('rounds timeout %ss up to %s minute(s)', async (timeout, minutes) => {
    setInputs({ timeout })

    await run()

    expect(pollTimeoutFlag()).toEqual(['--poll-timeout', minutes])
  })

  it('warns when the timeout is not a whole number of minutes', async () => {
    setInputs({ timeout: '90' })

    await run()

    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('rounding up to 2 minute(s)'),
      { title: 'Timeout rounded' },
    )
  })

  it.each(['600s', '10 minutes', 'abc', '-5', '1.5'])(
    'rejects the malformed timeout %j as not a whole number',
    async (timeout) => {
      setInputs({ timeout })

      await run()

      expect(execCalls).toHaveLength(0)
      expect(core.error).toHaveBeenCalledWith(
        expect.stringContaining('timeout must be a whole number of seconds'),
        { title: 'Bad timeout' },
      )
    },
  )

  it('rejects a zero timeout for its value, not as a parse failure', async () => {
    setInputs({ timeout: '0' })

    await run()

    expect(execCalls).toHaveLength(0)
    expect(core.error).toHaveBeenCalledWith(
      expect.stringContaining('timeout must be a positive number of seconds'),
      { title: 'Bad timeout' },
    )
  })

  // ── Cross-platform ───────────────────────────────────────────────────────────
  //
  // This suite runs on ubuntu, macOS and Windows in CI. These cases pin the two
  // properties that let one implementation cover all three: the action never
  // goes through a shell, and it runs whatever path ensureFsCli hands back
  // rather than a bare name it assumes PATH will resolve. The Windows-shaped
  // paths below are strings, so these cases check the action's own handling on
  // every leg; the Windows leg is what checks Windows itself.

  it.each([
    ['D:\\a\\_temp\\fs-cli\\fs-cli.exe', 'a GitHub-hosted Windows RUNNER_TEMP'],
    ['C:\\Program Files\\fs-cli\\fs-cli.exe', 'a self-hosted Windows path with a space'],
    ['/opt/my tools/fs-cli', 'a POSIX path with a space'],
    ['/usr/local/bin/fs-cli', 'a plain POSIX path'],
  ])('runs exactly the path ensureFsCli returned — %s, %s', async (fsCli) => {
    mockEnsureFsCli.mockResolvedValue(fsCli)

    await run()

    // exec() parses its first parameter as a command line even when an args
    // array is passed, so the path has to arrive quoted or it splits at the
    // space. spawn.test.ts runs a real process from a spaced path to prove the
    // quoting is the kind exec accepts.
    expect(commandLine()).toBe(`"${fsCli}"`)
  })

  it('never invokes a shell: arguments stay a list and no shell option is set', async () => {
    await run()

    const query = queryCall()
    // A single command string, or windowsVerbatimArguments, would mean argument
    // quoting differed between runners. Neither is used: the only keys exec is
    // given are the two this action sets on purpose.
    expect(Array.isArray(query.args)).toBe(true)
    expect(Object.keys(query.options).sort()).toEqual(['env', 'ignoreReturnCode'])
    expect(query.options.ignoreReturnCode).toBe(true)
  })

  it('installs fs-cli itself rather than requiring an earlier step to add it to PATH', async () => {
    await run()

    expect(mockEnsureFsCli).toHaveBeenCalledTimes(1)
  })

  it('titles an fs-cli that cannot be resolved or downloaded', async () => {
    mockEnsureFsCli.mockRejectedValue(
      new Error('fs-cli is not available for this runner (freebsd/x64).'),
    )

    await run()

    // ensureFsCli rejects rather than throwing, so this also pins that the
    // titling wrapper awaits what it runs.
    expect(execCalls).toHaveLength(0)
    expect(core.error).toHaveBeenCalledWith(
      expect.stringContaining('fs-cli is not available for this runner'),
      { title: 'fs-cli not found' },
    )
    expect(process.exitCode).toBe(1)
  })
})
