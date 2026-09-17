import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock @actions/core ─────────────────────────────────────────────────────────

vi.mock('@actions/core', () => ({
  getInput: vi.fn(),
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  setSecret: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}))

// ── Mock @actions/exec ─────────────────────────────────────────────────────────

const mockExec = vi.fn()

vi.mock('@actions/exec', () => ({
  exec: (...args: unknown[]) => mockExec(...args),
}))

// ── Mock @finite-state/core ────────────────────────────────────────────────────

const mockEnsureFsCli = vi.fn()

// quoteExecPath is the real one, imported from source rather than from the
// package's built dist so this suite does not need a core build: it decides
// what exec is actually handed, so a stub would leave the binary assertions
// below checking a value the action never builds.
vi.mock('@finite-state/core', async () => {
  const { quoteExecPath } = await import('../../../packages/core/src/exec-path')
  return {
    readSetupContext: vi.fn(),
    writeSetupContext: vi.fn(),
    FsClient: vi.fn().mockImplementation(() => ({})),
    ensureFsCli: (...args: unknown[]) => mockEnsureFsCli(...args),
    quoteExecPath,
  }
})

// ── Imports (after mocks) ──────────────────────────────────────────────────────

import * as core from '@actions/core'
import { readSetupContext, writeSetupContext } from '@finite-state/core'
// The parser exec() runs its first parameter through. Reached by file path
// because @actions/exec does not re-export it, and imported deliberately: it is
// the thing that splits an unquoted path on spaces, so a quoted fs-cli path is
// checked against the real implementation rather than an assumption about it.
import { argStringToArray } from '@actions/exec/lib/toolrunner'
import { parseScanIds, run } from '../src/main'

// ── Fixtures ───────────────────────────────────────────────────────────────────

type ExecOptions = { listeners?: { stdout?: (d: Buffer) => void; stderr?: (d: Buffer) => void } }

/** The executable path exec() would take from a command line the action built. */
function execPathOf(commandLine: string): string[] {
  return argStringToArray(commandLine)
}

/** The command line of the nth fs-cli call, as exec would parse it. */
function binaryOfCall(n = 0): string[] {
  return execPathOf(mockExec.mock.calls[n][0] as string)
}

/** Real fs-cli v2.3.33 output, trimmed to the lines carrying IDs. */
const FS_CLI_LOG = [
  'time=2026-09-16T19:27:22.415Z level=INFO msg="fs-cli starting" version=v2.3.33 command=scan',
  'time=2026-09-16T19:27:48.994Z level=INFO msg="using project" name=WebGoat id=9b590756-b726-4aaf-9dab-336f315789a2',
  'time=2026-09-16T19:27:49.784Z level=INFO msg="using version" version=main..453727d3 id=a097b616-c9b4-4f22-a924-798899c6ccae',
  'time=2026-09-16T19:27:58.380Z level=INFO msg="scan complete" project=WebGoat version=main..453727d3 submissionID=platform:9b590756-b726-4aaf-9dab-336f315789a2:a097b616-c9b4-4f22-a924-798899c6ccae',
].join('\n')

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('scan action', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    vi.mocked(core.getInput).mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        dir: '.',
        'project-id': '',
        version: 'v1.0.0',
        name: 'my-project',
        'extra-args': '',
      }
      return inputs[name] ?? ''
    })

    vi.mocked(readSetupContext).mockReturnValue({
      apiToken: 'test-token',
      domain: 'app.finitestate.io',
      projectId: 'proj-123',
      versionId: undefined,
    })

    mockExec.mockResolvedValue(0)
    mockEnsureFsCli.mockResolvedValue('/usr/local/bin/fs-cli')
  })

  it('always passes --name and includes --project-id when available', async () => {
    await run()

    expect(binaryOfCall()).toEqual(['/usr/local/bin/fs-cli'])
    expect(mockExec).toHaveBeenCalledWith(
      expect.any(String),
      [
        'scan',
        '--endpoint',
        'https://app.finitestate.io',
        '--token',
        'test-token',
        '--name',
        'my-project',
        '--version',
        'v1.0.0',
        '--project-id',
        'proj-123',
        '.',
      ],
      expect.objectContaining({ ignoreReturnCode: true }),
    )

    expect(core.setOutput).toHaveBeenCalledWith('exit-code', '0')
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('puts the scan target last, after flags and extra-args', async () => {
    vi.mocked(core.getInput).mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        dir: 'firmware/build',
        'project-id': '',
        version: 'v1.0.0',
        name: 'my-project',
        'extra-args': '--verbose --skip-upload',
      }
      return inputs[name] ?? ''
    })

    await run()

    const args = mockExec.mock.calls[0][1] as string[]
    expect(args[0]).toBe('scan')
    expect(args[args.length - 1]).toBe('firmware/build')
    expect(args.slice(-3)).toEqual(['--verbose', '--skip-upload', 'firmware/build'])
  })

  it('fails when fs-cli returns non-zero exit code', async () => {
    mockExec.mockResolvedValue(1)

    await run()

    expect(core.setOutput).toHaveBeenCalledWith('exit-code', '1')
    expect(core.setFailed).toHaveBeenCalledWith('fs-cli scan exited with code 1')
  })

  it('omits --project-id when no project-id is set', async () => {
    vi.mocked(core.getInput).mockImplementation((inputName: string) => {
      const inputs: Record<string, string> = {
        dir: '.',
        'project-id': '',
        version: 'v1.0.0',
        name: '',
        'extra-args': '',
      }
      return inputs[inputName] ?? ''
    })

    vi.mocked(readSetupContext).mockReturnValue({
      apiToken: 'test-token',
      domain: 'app.finitestate.io',
      projectId: undefined,
      versionId: undefined,
    })

    process.env.GITHUB_REPOSITORY = 'FiniteStateInc/my-firmware'

    await run()

    expect(binaryOfCall()).toEqual(['/usr/local/bin/fs-cli'])
    expect(mockExec).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['--name', 'my-firmware']),
      expect.objectContaining({ ignoreReturnCode: true }),
    )
    expect(mockExec).toHaveBeenCalledWith(
      expect.any(String),
      expect.not.arrayContaining(['--project-id']),
      expect.objectContaining({ ignoreReturnCode: true }),
    )

    delete process.env.GITHUB_REPOSITORY
  })

  it('fails when name is not available', async () => {
    vi.mocked(core.getInput).mockImplementation((inputName: string) => {
      const inputs: Record<string, string> = {
        dir: '.',
        'project-id': '',
        version: 'v1.0.0',
        name: '',
        'extra-args': '',
      }
      return inputs[inputName] ?? ''
    })

    delete process.env.GITHUB_REPOSITORY

    await run()

    expect(mockExec).not.toHaveBeenCalled()
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('name is required'))
  })

  it('falls back to the project name from setup when no name input is given', async () => {
    vi.mocked(core.getInput).mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        dir: '.',
        'project-id': '',
        version: 'v1.0.0',
        name: '',
        'extra-args': '',
      }
      return inputs[name] ?? ''
    })

    vi.mocked(readSetupContext).mockReturnValue({
      apiToken: 'test-token',
      domain: 'app.finitestate.io',
      projectId: undefined,
      projectName: 'WebGoat',
      versionId: undefined,
    })

    process.env.GITHUB_REPOSITORY = 'FiniteStateInc/some-repo'

    await run()

    const args = mockExec.mock.calls[0][1] as string[]
    expect(args).toEqual(expect.arrayContaining(['--name', 'WebGoat']))
    expect(args).not.toContain('--project-id')

    delete process.env.GITHUB_REPOSITORY
  })

  it('prefers an explicit name input over the setup project name', async () => {
    vi.mocked(readSetupContext).mockReturnValue({
      apiToken: 'test-token',
      domain: 'app.finitestate.io',
      projectId: undefined,
      projectName: 'WebGoat',
      versionId: undefined,
    })

    await run()

    const args = mockExec.mock.calls[0][1] as string[]
    expect(args).toEqual(expect.arrayContaining(['--name', 'my-project']))
  })

  it('runs standalone with its own api-token, installing fs-cli on demand', async () => {
    vi.mocked(core.getInput).mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        dir: '.',
        'api-token': 'standalone-token',
        domain: 'martinjones.finitestate.io',
        'project-name': 'WebGoat',
        version: 'v1.0.0',
        name: '',
        'project-id': '',
        'extra-args': '',
      }
      return inputs[name] ?? ''
    })

    vi.mocked(readSetupContext).mockReturnValue({
      apiToken: 'standalone-token',
      domain: 'martinjones.finitestate.io',
      projectId: undefined,
      versionId: undefined,
    })

    mockEnsureFsCli.mockResolvedValue('/runner/temp/fs-cli/fs-cli')

    await run()

    expect(readSetupContext).toHaveBeenCalledWith(
      expect.objectContaining({
        apiToken: 'standalone-token',
        domain: 'martinjones.finitestate.io',
      }),
    )
    expect(core.setSecret).toHaveBeenCalledWith('standalone-token')
    expect(mockEnsureFsCli).toHaveBeenCalled()

    const [, args] = mockExec.mock.calls[0]
    // Quoted on the way to exec, which parses its first parameter as a command
    // line: what matters is the single path that comes back out.
    expect(binaryOfCall()).toEqual(['/runner/temp/fs-cli/fs-cli'])
    expect(args).toEqual(
      expect.arrayContaining([
        '--endpoint',
        'https://martinjones.finitestate.io',
        '--name',
        'WebGoat',
      ]),
    )
    expect(args).not.toContain('--project-id')
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('exports the context so later steps inherit auth without setup', async () => {
    await run()

    expect(writeSetupContext).toHaveBeenCalledWith({
      apiToken: 'test-token',
      domain: 'app.finitestate.io',
      projectId: 'proj-123',
      projectName: 'my-project',
    })
    expect(core.setOutput).toHaveBeenCalledWith('project-id', 'proj-123')
  })

  it('never exports the version label as a version ID', async () => {
    await run()

    expect(vi.mocked(writeSetupContext).mock.calls[0][0].versionId).toBeUndefined()
  })

  it('exports the context before fs-cli runs, so an always() step still has it', async () => {
    mockExec.mockRejectedValueOnce(new Error('fs-cli blew up'))

    await run()

    expect(writeSetupContext).toHaveBeenCalled()
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('fs-cli blew up'))
  })

  it('publishes the project and version IDs fs-cli resolved', async () => {
    vi.mocked(readSetupContext).mockReturnValue({
      apiToken: 'test-token',
      domain: 'app.finitestate.io',
      projectId: undefined,
      versionId: undefined,
    })
    mockExec.mockImplementation(async (_bin: string, _args: string[], options: ExecOptions) => {
      options.listeners?.stderr?.(Buffer.from(FS_CLI_LOG))
      return 0
    })

    await run()

    expect(core.setOutput).toHaveBeenCalledWith(
      'version-id',
      'a097b616-c9b4-4f22-a924-798899c6ccae',
    )
    expect(core.setOutput).toHaveBeenCalledWith(
      'project-id',
      '9b590756-b726-4aaf-9dab-336f315789a2',
    )
    expect(writeSetupContext).toHaveBeenLastCalledWith({
      apiToken: 'test-token',
      domain: 'app.finitestate.io',
      projectId: '9b590756-b726-4aaf-9dab-336f315789a2',
      projectName: 'my-project',
      versionId: 'a097b616-c9b4-4f22-a924-798899c6ccae',
    })
    expect(core.warning).not.toHaveBeenCalled()
  })

  it('warns instead of failing when fs-cli output carries no version ID', async () => {
    mockExec.mockImplementation(async (_bin: string, _args: string[], options: ExecOptions) => {
      options.listeners?.stdout?.(Buffer.from('nothing useful here\n'))
      return 0
    })

    await run()

    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('version ID'))
    expect(core.setOutput).not.toHaveBeenCalledWith('version-id', expect.anything())
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('prefers an explicit project-id over the one fs-cli reports', async () => {
    mockExec.mockImplementation(async (_bin: string, _args: string[], options: ExecOptions) => {
      options.listeners?.stderr?.(Buffer.from(FS_CLI_LOG))
      return 0
    })

    await run()

    expect(core.setOutput).toHaveBeenCalledWith('project-id', 'proj-123')
  })
})

describe('parseScanIds', () => {
  it('reads both IDs from the submission ID', () => {
    expect(parseScanIds(FS_CLI_LOG)).toEqual({
      projectId: '9b590756-b726-4aaf-9dab-336f315789a2',
      versionId: 'a097b616-c9b4-4f22-a924-798899c6ccae',
    })
  })

  it('falls back to the using-project and using-version lines', () => {
    const interrupted = FS_CLI_LOG.split('msg="scan complete"')[0]

    expect(parseScanIds(interrupted)).toEqual({
      projectId: '9b590756-b726-4aaf-9dab-336f315789a2',
      versionId: 'a097b616-c9b4-4f22-a924-798899c6ccae',
    })
  })

  it('does not mistake the project ID for the version ID', () => {
    const projectOnly =
      'time=2026-09-16T19:27:48.994Z level=INFO msg="using project" name=WebGoat id=9b590756-b726-4aaf-9dab-336f315789a2\n'

    expect(parseScanIds(projectOnly)).toEqual({
      projectId: '9b590756-b726-4aaf-9dab-336f315789a2',
      versionId: undefined,
    })
  })

  it('returns nothing for output with no IDs', () => {
    expect(parseScanIds('fs-cli starting\n')).toEqual({
      projectId: undefined,
      versionId: undefined,
    })
  })
})
