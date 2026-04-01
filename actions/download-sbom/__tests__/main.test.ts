import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock @actions/core ─────────────────────────────────────────────────────────

vi.mock('@actions/core', () => ({
  getInput: vi.fn(),
  getBooleanInput: vi.fn(),
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  info: vi.fn(),
}))

// ── Mock @actions/artifact ─────────────────────────────────────────────────────

const mockUploadArtifact = vi.fn()

vi.mock('@actions/artifact', () => ({
  DefaultArtifactClient: vi.fn().mockImplementation(() => ({
    uploadArtifact: mockUploadArtifact,
  })),
}))

// ── Mock fs ────────────────────────────────────────────────────────────────────

vi.mock('fs', () => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}))

// ── Mock @finite-state/core ────────────────────────────────────────────────────

const mockDownloadSbom = vi.fn()

vi.mock('@finite-state/core', () => ({
  FsClient: vi.fn().mockImplementation(() => ({
    downloadSbom: mockDownloadSbom,
  })),
  readSetupContext: vi.fn(),
}))

// ── Imports (after mocks) ──────────────────────────────────────────────────────

import * as core from '@actions/core'
import { readSetupContext } from '@finite-state/core'
import { run } from '../src/main'

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('download-sbom action', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    vi.mocked(readSetupContext).mockReturnValue({
      apiToken: 'test-token',
      domain: 'app.finitestate.io',
      projectId: 'proj-123',
      versionId: 'ver-456',
    })

    vi.mocked(core.getInput).mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        'version-id': '',
        format: 'cyclonedx',
        'include-vex': 'true',
        'output-file': 'sbom.json',
        'upload-artifact': 'true',
        'artifact-name': 'finite-state-sbom',
      }
      return inputs[name] ?? ''
    })

    vi.mocked(core.getBooleanInput).mockImplementation((name: string) => {
      if (name === 'include-vex') return true
      if (name === 'upload-artifact') return true
      return false
    })

    mockDownloadSbom.mockResolvedValue({
      bomFormat: 'CycloneDX',
      components: [
        { name: 'openssl', version: '1.1.1' },
        { name: 'zlib', version: '1.2.11' },
        { name: 'libpng', version: '1.6.37' },
      ],
    })

    mockUploadArtifact.mockResolvedValue({ artifactId: 99, size: 2048 })
  })

  it('downloads CycloneDX SBOM with VEX and uploads artifact', async () => {
    await run()

    // downloadSbom called with correct args
    expect(mockDownloadSbom).toHaveBeenCalledWith('ver-456', 'cyclonedx', true)

    // outputs set correctly
    expect(core.setOutput).toHaveBeenCalledWith('file', 'sbom.json')
    expect(core.setOutput).toHaveBeenCalledWith('component-count', '3')
    expect(core.setOutput).toHaveBeenCalledWith('artifact-name', 'finite-state-sbom')

    // artifact upload was called
    expect(mockUploadArtifact).toHaveBeenCalledWith(
      'finite-state-sbom',
      ['sbom.json'],
      expect.any(String),
    )

    // no failure
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('fails when no version-id available', async () => {
    vi.mocked(readSetupContext).mockReturnValue({
      apiToken: 'test-token',
      domain: 'app.finitestate.io',
      projectId: 'proj-123',
      versionId: undefined,
    })

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('version-id'))
    expect(mockDownloadSbom).not.toHaveBeenCalled()
  })
})
