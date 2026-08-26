import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock @actions/core ─────────────────────────────────────────────────────────

vi.mock('@actions/core', () => ({
  getInput: vi.fn(),
  warning: vi.fn(),
  getBooleanInput: vi.fn(),
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  setSecret: vi.fn(),
  exportVariable: vi.fn(),
  info: vi.fn(),
}))

// ── Mock fs ────────────────────────────────────────────────────────────────────

vi.mock('fs', () => ({
  readFileSync: vi.fn().mockReturnValue(Buffer.from('fake-file-contents')),
}))

const mockGlobMatches: string[] = []

vi.mock('fs/promises', () => ({
  glob: () =>
    (async function* () {
      for (const match of mockGlobMatches) yield match
    })(),
}))

// ── Mock @finite-state/core ────────────────────────────────────────────────────

const mockCreateVersion = vi.fn()
const mockCreateProject = vi.fn()
const mockUploadScan = vi.fn()
const mockPollScanCompletion = vi.fn()
const mockResolveProjectId = vi.fn()

vi.mock('@finite-state/core', () => {
  class ProjectNotFoundError extends Error {
    constructor(public readonly projectName: string) {
      super(`No project found with name "${projectName}".`)
      this.name = 'ProjectNotFoundError'
    }
  }

  return {
    FsClient: vi.fn().mockImplementation(() => ({
      createVersion: mockCreateVersion,
      createProject: mockCreateProject,
      uploadScan: mockUploadScan,
      pollScanCompletion: mockPollScanCompletion,
    })),
    ProjectNotFoundError,
    resolveProjectId: (...args: unknown[]) => mockResolveProjectId(...args),
    readSetupContext: vi.fn(),
  }
})

// ── Imports (after mocks) ──────────────────────────────────────────────────────

import * as core from '@actions/core'
import { ProjectNotFoundError, readSetupContext } from '@finite-state/core'
import { run } from '../src/main'

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('upload action', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    vi.mocked(readSetupContext).mockReturnValue({
      apiToken: 'test-token',
      domain: 'app.finitestate.io',
      projectId: '42',
      versionId: undefined,
    })

    vi.mocked(core.getInput).mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        type: 'sca',
        file: '/tmp/results.json',
        'project-id': '',
        version: 'v1.2.3',
        'version-id': '',
        'scanner-type': '',
        'sbom-format': '',
        'wait-for-completion': 'true',
        timeout: '600',
      }
      return inputs[name] ?? ''
    })

    vi.mocked(core.getBooleanInput).mockImplementation((name: string) => {
      if (name === 'wait-for-completion') return true
      return false
    })

    mockCreateVersion.mockResolvedValue({
      id: 'ver-999',
      name: 'v1.2.3',
      projectId: '42',
      createdAt: '',
    })
    mockUploadScan.mockResolvedValue({ id: 'scan-123' })
    mockCreateProject.mockResolvedValue({ id: 'proj-new', name: 'WebGoat-BINARY' })
    mockResolveProjectId.mockResolvedValue('proj-existing')
    mockGlobMatches.length = 0
    mockPollScanCompletion.mockResolvedValue({
      id: 'scan-123',
      status: 'COMPLETED',
      scanType: 'sca',
      createdAt: '',
      versionId: 'ver-999',
    })
  })

  it('creates version and uploads SCA scan', async () => {
    await run()

    // createVersion was called with the projectId and version name
    expect(mockCreateVersion).toHaveBeenCalledWith('42', 'v1.2.3')

    // uploadScan was called with the correct arguments
    expect(mockUploadScan).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'sca',
        filename: 'results.json',
        projectVersionId: 'ver-999',
      }),
    )

    // pollScanCompletion was called
    expect(mockPollScanCompletion).toHaveBeenCalledWith('ver-999', 600_000, expect.any(Number))

    // outputs were set
    expect(core.setOutput).toHaveBeenCalledWith('scan-id', 'scan-123')
    expect(core.setOutput).toHaveBeenCalledWith('version-id', 'ver-999')
    expect(core.setOutput).toHaveBeenCalledWith('scan-status', 'COMPLETED')

    // FINITE_STATE_VERSION_ID env var was exported
    expect(core.exportVariable).toHaveBeenCalledWith('FINITE_STATE_VERSION_ID', 'ver-999')

    // no failure
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('uses existing version-id without creating a new version', async () => {
    vi.mocked(core.getInput).mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        type: 'sca',
        file: '/tmp/results.json',
        'project-id': '',
        version: '',
        'version-id': 'ver-existing',
        'scanner-type': '',
        'sbom-format': '',
        'wait-for-completion': 'true',
        timeout: '600',
      }
      return inputs[name] ?? ''
    })

    await run()

    // createVersion was NOT called
    expect(mockCreateVersion).not.toHaveBeenCalled()

    // uploadScan was called with the existing version-id
    expect(mockUploadScan).toHaveBeenCalledWith(
      expect.objectContaining({
        projectVersionId: 'ver-existing',
      }),
    )

    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('skips polling when wait-for-completion is false', async () => {
    vi.mocked(core.getBooleanInput).mockImplementation((name: string) => {
      if (name === 'wait-for-completion') return false
      return false
    })

    await run()

    // pollScanCompletion was NOT called
    expect(mockPollScanCompletion).not.toHaveBeenCalled()

    // scan-status set to SUBMITTED
    expect(core.setOutput).toHaveBeenCalledWith('scan-status', 'SUBMITTED')

    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('uploads once per comma-separated type', async () => {
    vi.mocked(core.getInput).mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        type: 'sca,sast,config,vulnerability-analysis',
        file: '/tmp/app.jar',
        version: 'v1.2.3',
        'wait-for-completion': 'false',
        timeout: '600',
      }
      return inputs[name] ?? ''
    })
    vi.mocked(core.getBooleanInput).mockReturnValue(false)
    mockUploadScan
      .mockResolvedValueOnce({ id: 's1' })
      .mockResolvedValueOnce({ id: 's2' })
      .mockResolvedValueOnce({ id: 's3' })
      .mockResolvedValueOnce({ id: 's4' })

    await run()

    expect(mockUploadScan).toHaveBeenCalledTimes(4)
    expect(mockUploadScan.mock.calls.map((c) => c[0].type)).toEqual([
      'sca',
      'sast',
      'config',
      'vulnerability-analysis',
    ])
    expect(core.setOutput).toHaveBeenCalledWith('scan-id', 's1')
    expect(core.setOutput).toHaveBeenCalledWith('scan-ids', 's1,s2,s3,s4')
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('creates the project when project-name matches nothing', async () => {
    vi.mocked(readSetupContext).mockReturnValue({
      apiToken: 'standalone-token',
      domain: 'martinjones.finitestate.io',
      projectId: undefined,
      versionId: undefined,
    })
    vi.mocked(core.getInput).mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        'api-token': 'standalone-token',
        domain: 'martinjones.finitestate.io',
        'project-name': 'WebGoat-BINARY',
        'project-type': 'application',
        type: 'sca',
        file: '/tmp/app.jar',
        version: 'v1.2.3',
        'wait-for-completion': 'false',
        timeout: '600',
      }
      return inputs[name] ?? ''
    })
    vi.mocked(core.getBooleanInput).mockReturnValue(false)
    mockResolveProjectId.mockRejectedValue(new ProjectNotFoundError('WebGoat-BINARY'))

    await run()

    expect(mockCreateProject).toHaveBeenCalledWith('WebGoat-BINARY', {
      projectType: 'application',
    })
    expect(mockCreateVersion).toHaveBeenCalledWith('proj-new', 'v1.2.3')
    expect(core.setSecret).toHaveBeenCalledWith('standalone-token')
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('reuses an existing project matched by name', async () => {
    vi.mocked(readSetupContext).mockReturnValue({
      apiToken: 'test-token',
      domain: 'app.finitestate.io',
      projectId: undefined,
      versionId: undefined,
    })
    vi.mocked(core.getInput).mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        'project-name': 'WebGoat',
        type: 'sca',
        file: '/tmp/app.jar',
        version: 'v1.2.3',
        'wait-for-completion': 'false',
        timeout: '600',
      }
      return inputs[name] ?? ''
    })
    vi.mocked(core.getBooleanInput).mockReturnValue(false)

    await run()

    expect(mockCreateProject).not.toHaveBeenCalled()
    expect(mockCreateVersion).toHaveBeenCalledWith('proj-existing', 'v1.2.3')
  })

  it('expands a glob that matches exactly one file', async () => {
    vi.mocked(core.getInput).mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        type: 'sca',
        file: 'target/webgoat-*.jar',
        version: 'v1.2.3',
        'wait-for-completion': 'false',
        timeout: '600',
      }
      return inputs[name] ?? ''
    })
    vi.mocked(core.getBooleanInput).mockReturnValue(false)
    mockGlobMatches.push('target/webgoat-2025.4.jar')

    await run()

    expect(mockUploadScan).toHaveBeenCalledWith(
      expect.objectContaining({ filename: 'webgoat-2025.4.jar' }),
    )
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('fails when a glob matches more than one file', async () => {
    vi.mocked(core.getInput).mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        type: 'sca',
        file: 'target/webgoat-*.jar',
        version: 'v1.2.3',
        'wait-for-completion': 'false',
        timeout: '600',
      }
      return inputs[name] ?? ''
    })
    vi.mocked(core.getBooleanInput).mockReturnValue(false)
    mockGlobMatches.push('target/webgoat-2025.4.jar', 'target/webgoat-2025.4-sources.jar')

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('matches 2 files'))
    expect(mockUploadScan).not.toHaveBeenCalled()
  })

  it('fails with a clear error when a glob matches nothing', async () => {
    vi.mocked(core.getInput).mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        type: 'sca',
        file: 'target/nope-*.jar',
        version: 'v1.2.3',
        'wait-for-completion': 'false',
        timeout: '600',
      }
      return inputs[name] ?? ''
    })
    vi.mocked(core.getBooleanInput).mockReturnValue(false)

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('No file matches'))
  })
})
