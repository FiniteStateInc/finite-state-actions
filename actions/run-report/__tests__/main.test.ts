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
        folder: '',
        component: '',
        'data-file': '',
        left: '',
        right: '',
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
        '--project',
        'proj-123',
        '--version',
        'ver-456',
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
        folder: '',
        component: '',
        'data-file': '',
        left: '',
        right: '',
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
        folder: '',
        component: '',
        'data-file': '',
        left: '',
        right: '',
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

    const fsReportCall = vi.mocked(exec.exec).mock.calls.find((call) => call[0] === 'fs-report')

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

  it('scopes with --project/--version, the flags fs-report run actually defines', async () => {
    await run()

    const args = vi.mocked(exec.exec).mock.calls.find((c) => c[0] === 'fs-report')![1] as string[]

    expect(args).not.toContain('--project-id')
    expect(args).not.toContain('--version-id')
  })

  it('runs the compare subcommand when left and right scopes are set', async () => {
    vi.mocked(core.getInput).mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        recipe: 'Component Diff',
        left: 'project:BN85@v3.2.1',
        right: 'project:BN85@v3.3.0',
        'output-dir': './fs-reports',
        'cache-ttl': '1',
      }
      return inputs[name] ?? ''
    })
    vi.mocked(core.getBooleanInput).mockImplementation(() => false)

    await run()

    const args = vi.mocked(exec.exec).mock.calls.find((c) => c[0] === 'fs-report')![1] as string[]

    expect(args.slice(0, 6)).toEqual([
      'compare',
      'Component Diff',
      '--left',
      'project:BN85@v3.2.1',
      '--right',
      'project:BN85@v3.3.0',
    ])
    // `compare` rejects the run-only flags, so none of them may leak through.
    expect(args).not.toContain('--headless')
    expect(args).not.toContain('--recipe')
    expect(args).not.toContain('--cache-ttl')
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('fails when only one side of a comparison scope is given', async () => {
    vi.mocked(core.getInput).mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        recipe: 'Component Diff',
        left: 'project:BN85@v3.2.1',
        'output-dir': './fs-reports',
        'cache-ttl': '1',
      }
      return inputs[name] ?? ''
    })
    vi.mocked(core.getBooleanInput).mockImplementation(() => false)

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(
      "Comparison reports need both 'left' and 'right' scope references",
    )
  })

  it('passes the recipe-specific scope flags through', async () => {
    vi.mocked(core.getInput).mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        recipe: 'Component Impact,Assessment Overview,Exploitability Report',
        folder: 'Gateways',
        component: 'openssl',
        'data-file': './evidence.json',
        'output-dir': './fs-reports',
        'cache-ttl': '1',
      }
      return inputs[name] ?? ''
    })
    vi.mocked(core.getBooleanInput).mockImplementation(() => false)

    await run()

    const args = vi.mocked(exec.exec).mock.calls.find((c) => c[0] === 'fs-report')![1] as string[]

    expect(args).toEqual(
      expect.arrayContaining([
        '--folder',
        'Gateways',
        '--component',
        'openssl',
        '--data-file',
        './evidence.json',
      ]),
    )
    expect(core.setFailed).not.toHaveBeenCalled()
  })
})
