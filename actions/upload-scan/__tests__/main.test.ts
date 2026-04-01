import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock @actions/core ─────────────────────────────────────────────────────────

vi.mock('@actions/core', () => ({
  getInput: vi.fn(),
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

// ── Mock @finite-state/core ────────────────────────────────────────────────────

const mockCreateVersion = vi.fn()
const mockUploadScan = vi.fn()
const mockPollScanCompletion = vi.fn()

vi.mock('@finite-state/core', () => ({
  FsClient: vi.fn().mockImplementation(() => ({
    createVersion: mockCreateVersion,
    uploadScan: mockUploadScan,
    pollScanCompletion: mockPollScanCompletion,
  })),
  readSetupContext: vi.fn(),
}))

// ── Imports (after mocks) ──────────────────────────────────────────────────────

import * as core from '@actions/core'
import { readSetupContext } from '@finite-state/core'
import { run } from '../src/main'

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('upload-scan action', () => {
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

    mockCreateVersion.mockResolvedValue({ id: 'ver-999', name: 'v1.2.3', projectId: '42', createdAt: '' })
    mockUploadScan.mockResolvedValue({ id: 'scan-123' })
    mockPollScanCompletion.mockResolvedValue({ id: 'scan-123', status: 'COMPLETED', scanType: 'sca', createdAt: '', versionId: 'ver-999' })
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

    // FS_VERSION_ID env var was exported
    expect(core.exportVariable).toHaveBeenCalledWith('FS_VERSION_ID', 'ver-999')

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
})
