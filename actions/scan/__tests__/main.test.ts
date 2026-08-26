import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock @actions/core ─────────────────────────────────────────────────────────

vi.mock('@actions/core', () => ({
  getInput: vi.fn(),
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  setSecret: vi.fn(),
  info: vi.fn(),
}))

// ── Mock @actions/exec ─────────────────────────────────────────────────────────

const mockExec = vi.fn()

vi.mock('@actions/exec', () => ({
  exec: (...args: unknown[]) => mockExec(...args),
}))

// ── Mock @finite-state/core ────────────────────────────────────────────────────

const mockEnsureFsCli = vi.fn()

vi.mock('@finite-state/core', () => ({
  readSetupContext: vi.fn(),
  FsClient: vi.fn().mockImplementation(() => ({})),
  ensureFsCli: (...args: unknown[]) => mockEnsureFsCli(...args),
}))

// ── Imports (after mocks) ──────────────────────────────────────────────────────

import * as core from '@actions/core'
import { readSetupContext } from '@finite-state/core'
import { run } from '../src/main'

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

    expect(mockExec).toHaveBeenCalledWith(
      '/usr/local/bin/fs-cli',
      [
        'scan',
        '.',
        '--token',
        'test-token',
        '--endpoint',
        'https://app.finitestate.io',
        '--version',
        'v1.0.0',
        '--name',
        'my-project',
        '--project-id',
        'proj-123',
      ],
      { ignoreReturnCode: true },
    )

    expect(core.setOutput).toHaveBeenCalledWith('exit-code', '0')
    expect(core.setFailed).not.toHaveBeenCalled()
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

    expect(mockExec).toHaveBeenCalledWith(
      '/usr/local/bin/fs-cli',
      expect.arrayContaining(['--name', 'my-firmware']),
      { ignoreReturnCode: true },
    )
    expect(mockExec).toHaveBeenCalledWith(
      '/usr/local/bin/fs-cli',
      expect.not.arrayContaining(['--project-id']),
      { ignoreReturnCode: true },
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

    const [binary, args] = mockExec.mock.calls[0]
    expect(binary).toBe('/runner/temp/fs-cli/fs-cli')
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
})
