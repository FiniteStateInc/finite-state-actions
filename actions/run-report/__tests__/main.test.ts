import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock @actions/core ─────────────────────────────────────────────────────────

vi.mock('@actions/core', () => ({
  getInput: vi.fn(),
  getBooleanInput: vi.fn(),
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}))

// ── Mock @actions/exec ─────────────────────────────────────────────────────────

vi.mock('@actions/exec', () => ({
  exec: vi.fn().mockResolvedValue(0),
}))

// ── Mock @actions/artifact ─────────────────────────────────────────────────────

const mockUploadArtifact = vi.fn()

vi.mock('@actions/artifact', () => ({
  DefaultArtifactClient: vi.fn().mockImplementation(() => ({
    uploadArtifact: mockUploadArtifact,
  })),
}))

// ── Mock fs ────────────────────────────────────────────────────────────────────

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    readdirSync: vi.fn().mockReturnValue([]),
    statSync: vi.fn().mockReturnValue({ isDirectory: () => false }),
  }
})

// ── Mock @finite-state/core ────────────────────────────────────────────────────

vi.mock('@finite-state/core', () => ({
  parseReportDirectory: vi.fn(),
  readSetupContext: vi.fn(),
}))

// ── Imports (after mocks) ──────────────────────────────────────────────────────

import * as core from '@actions/core'
import * as exec from '@actions/exec'
import { parseReportDirectory, readSetupContext } from '@finite-state/core'
import { run } from '../src/main'

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('run-report action', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    vi.mocked(readSetupContext).mockReturnValue({
      apiToken: 'test-token',
      domain: 'app.finitestate.io',
      projectId: 'proj-123',
      versionId: 'ver-456',
    })

    vi.mocked(parseReportDirectory).mockReturnValue({
      severityCounts: { CRITICAL: 5, HIGH: 10, MEDIUM: 20, LOW: 15, NONE: 0 },
      totalFindings: 50,
      triageBands: { P0: 3, P1: 7, P2: 10, P3: 5, topFindings: [] },
      versionDelta: {
        newFindings: [{ findingId: 'CVE-2024-1234', severity: 'HIGH', risk: 0, component: 'foo' }],
        fixedFindings: [],
        newBySeverity: { CRITICAL: 0, HIGH: 1, MEDIUM: 0, LOW: 0, NONE: 0 },
        fixedBySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, NONE: 0 },
      },
    })

    mockUploadArtifact.mockResolvedValue({ artifactId: 42, size: 1024 })

    vi.mocked(core.getInput).mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        recipe: 'Triage Prioritization',
        'project-id': '',
        'version-id': '',
        'baseline-version': '',
        'current-version': '',
        period: '30d',
        cve: '',
        'finding-types': '',
        'open-only': 'true',
        'scoring-file': '',
        ai: 'false',
        'ai-prompts': 'false',
        'output-dir': './fs-reports',
        'fs-report-version': '',
        'cache-ttl': '1',
        'extra-args': '',
      }
      return inputs[name] ?? ''
    })

    vi.mocked(core.getBooleanInput).mockImplementation((name: string) => {
      if (name === 'open-only') return true
      if (name === 'ai') return false
      if (name === 'ai-prompts') return false
      return false
    })
  })

  it('installs fs-report and runs with correct arguments', async () => {
    await run()

    // Verify pipx install was called
    expect(exec.exec).toHaveBeenCalledWith(
      'pipx',
      expect.arrayContaining(['install', 'fs-report', '--force']),
      expect.any(Object),
    )

    // Verify fs-report run was called with expected flags
    expect(exec.exec).toHaveBeenCalledWith(
      'fs-report',
      expect.arrayContaining([
        'run',
        '--headless',
        '--output',
        './fs-reports',
        '--cache-ttl',
        '1',
        '--recipe',
        'Triage Prioritization',
        '--period',
        '30d',
        '--open-only',
      ]),
      expect.any(Object),
    )

    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('passes AI flag when enabled', async () => {
    vi.mocked(core.getInput).mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        recipe: 'Triage Prioritization',
        'project-id': '',
        'version-id': '',
        'baseline-version': '',
        'current-version': '',
        period: '',
        cve: '',
        'finding-types': '',
        'open-only': 'false',
        'scoring-file': '',
        ai: 'true',
        'ai-prompts': 'false',
        'output-dir': './fs-reports',
        'fs-report-version': '',
        'cache-ttl': '1',
        'extra-args': '',
      }
      return inputs[name] ?? ''
    })

    vi.mocked(core.getBooleanInput).mockImplementation((name: string) => {
      if (name === 'open-only') return false
      if (name === 'ai') return true
      if (name === 'ai-prompts') return false
      return false
    })

    await run()

    expect(exec.exec).toHaveBeenCalledWith(
      'fs-report',
      expect.arrayContaining(['--ai']),
      expect.any(Object),
    )

    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('passes multiple recipes as separate --recipe flags', async () => {
    vi.mocked(core.getInput).mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        recipe: 'Triage Prioritization, Version Comparison, Executive Summary',
        'project-id': '',
        'version-id': '',
        'baseline-version': '',
        'current-version': '',
        period: '',
        cve: '',
        'finding-types': '',
        'open-only': 'false',
        'scoring-file': '',
        ai: 'false',
        'ai-prompts': 'false',
        'output-dir': './fs-reports',
        'fs-report-version': '',
        'cache-ttl': '1',
        'extra-args': '',
      }
      return inputs[name] ?? ''
    })

    vi.mocked(core.getBooleanInput).mockImplementation(() => false)

    await run()

    const fsReportCall = vi.mocked(exec.exec).mock.calls.find(
      (call) => call[0] === 'fs-report',
    )

    expect(fsReportCall).toBeDefined()
    const args = fsReportCall![1] as string[]

    // Count occurrences of '--recipe'
    const recipeCount = args.filter((a) => a === '--recipe').length
    expect(recipeCount).toBe(3)

    expect(args).toContain('Triage Prioritization')
    expect(args).toContain('Version Comparison')
    expect(args).toContain('Executive Summary')

    expect(core.setFailed).not.toHaveBeenCalled()
  })
})
