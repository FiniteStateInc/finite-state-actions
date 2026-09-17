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
  setFailed: vi.fn(),
  setSecret: vi.fn(),
  info: vi.fn(),
}))

// ── Mock @finite-state/core ────────────────────────────────────────────────────
//
// parseTimeoutMinutes is the real one, imported from source rather than from
// the package's built dist so this suite does not need a core build: it is the
// whole of this action's input validation, and a stub would leave the rounding
// and the rejections below asserting nothing.

const mockEnsureFsCli = vi.fn()

vi.mock('@finite-state/core', async () => {
  const { parseTimeoutMinutes } = await import('../../../packages/core/src/timeout')
  return {
    FsClient: vi.fn().mockImplementation(() => ({})),
    ensureFsCli: (...args: unknown[]) => mockEnsureFsCli(...args),
    readSetupContext: vi.fn(),
    parseTimeoutMinutes,
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

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('wait action', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    execCalls.length = 0
    exitCode = 0

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
    expect(query.binary).toBe('/usr/local/bin/fs-cli')
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
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('No version to wait on'))
  })

  it('fails with the exit code, version and domain when fs-cli does not settle', async () => {
    exitCode = 3

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('fs-cli query exited 3 for version ver-999 on app.finitestate.io'),
    )
  })

  it('reports a missing token through the context error', async () => {
    vi.mocked(readSetupContext).mockImplementation(() => {
      throw new Error('FINITE_STATE_AUTH_TOKEN is not set.')
    })

    await run()

    expect(execCalls).toHaveLength(0)
    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('FINITE_STATE_AUTH_TOKEN is not set.'),
    )
  })

  // ── timeout ──────────────────────────────────────────────────────────────────

  it('omits --poll-timeout when no timeout is given', async () => {
    await run()

    expect(queryCall().args).not.toContain('--poll-timeout')
  })

  it('converts a whole-minute timeout without warning', async () => {
    setInputs({ timeout: '600' })

    await run()

    expect(queryCall().args).toEqual(expect.arrayContaining(['--poll-timeout', '10']))
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

    expect(queryCall().args).toEqual(expect.arrayContaining(['--poll-timeout', minutes]))
  })

  it('warns when the timeout is not a whole number of minutes', async () => {
    setInputs({ timeout: '90' })

    await run()

    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('rounding up to 2 minute(s)'))
  })

  it.each(['600s', '10 minutes', 'abc', '-5', '1.5', '0'])(
    'rejects the malformed timeout %j',
    async (timeout) => {
      setInputs({ timeout })

      await run()

      expect(execCalls).toHaveLength(0)
      expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('timeout must be a'))
    },
  )

  // ── Cross-platform ───────────────────────────────────────────────────────────
  //
  // This suite runs on ubuntu, macOS and Windows in CI. These cases pin the two
  // properties that let one implementation cover all three: the action never
  // goes through a shell, and it runs whatever path ensureFsCli hands back
  // rather than a bare name it assumes PATH will resolve.

  it('runs the exact binary path ensureFsCli returned, including a Windows .exe', async () => {
    mockEnsureFsCli.mockResolvedValue('D:\\a\\_temp\\fs-cli\\fs-cli.exe')

    await run()

    expect(queryCall().binary).toBe('D:\\a\\_temp\\fs-cli\\fs-cli.exe')
  })

  it('never invokes a shell: arguments stay a list and no shell option is set', async () => {
    await run()

    const query = queryCall()
    // A single command string, or windowsVerbatimArguments, would mean argument
    // quoting differed between runners. Neither is used.
    expect(Array.isArray(query.args)).toBe(true)
    expect(query.options).not.toHaveProperty('shell')
    expect(query.options).not.toHaveProperty('windowsVerbatimArguments')
  })

  it('installs fs-cli itself rather than requiring an earlier step to add it to PATH', async () => {
    await run()

    expect(mockEnsureFsCli).toHaveBeenCalledTimes(1)
  })
})
