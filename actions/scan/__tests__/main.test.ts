import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock @actions/core ─────────────────────────────────────────────────────────

vi.mock('@actions/core', () => ({
  getInput: vi.fn(),
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  info: vi.fn(),
}))

// ── Mock @actions/exec ─────────────────────────────────────────────────────────

const mockExec = vi.fn()

vi.mock('@actions/exec', () => ({
  exec: (...args: unknown[]) => mockExec(...args),
}))

// ── Mock @finite-state/core ────────────────────────────────────────────────────

vi.mock('@finite-state/core', () => ({
  readSetupContext: vi.fn(),
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
  })

  it('passes --project-id and omits --name when project-id is set', async () => {
    await run()

    expect(mockExec).toHaveBeenCalledWith(
      'fs-cli',
      [
        'scan',
        '.',
        '--token',
        'test-token',
        '--endpoint',
        'https://app.finitestate.io',
        '--version',
        'v1.0.0',
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

  it('passes --name instead of --project-id when no project-id is set', async () => {
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
      'fs-cli',
      expect.arrayContaining(['--name', 'my-firmware']),
      { ignoreReturnCode: true },
    )
    expect(mockExec).toHaveBeenCalledWith(
      'fs-cli',
      expect.not.arrayContaining(['--project-id']),
      { ignoreReturnCode: true },
    )

    delete process.env.GITHUB_REPOSITORY
  })

  it('fails when neither project-id nor name is available', async () => {
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

    delete process.env.GITHUB_REPOSITORY

    await run()

    expect(mockExec).not.toHaveBeenCalled()
    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('Either project-id or name is required'),
    )
  })
})
