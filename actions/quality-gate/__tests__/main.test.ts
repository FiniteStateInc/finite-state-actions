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

// ── Mock @finite-state/core ────────────────────────────────────────────────────

vi.mock('@finite-state/core', () => ({
  evaluateGates: vi.fn(),
  parseReportDirectory: vi.fn(),
}))

// ── Imports (after mocks) ──────────────────────────────────────────────────────

import * as core from '@actions/core'
import { evaluateGates } from '@finite-state/core'
import { run } from '../src/main'

// ── Shared test fixtures ───────────────────────────────────────────────────────

const baseSummary = {
  severityCounts: { CRITICAL: 2, HIGH: 5, MEDIUM: 10, LOW: 3, NONE: 0 },
  totalFindings: 20,
  triageBands: { P0: 2, P1: 5, P2: 8, P3: 5, topFindings: [] },
  versionDelta: {
    newFindings: [{ findingId: 'CVE-2024-0001', severity: 'CRITICAL', risk: 90, component: 'foo' }],
    fixedFindings: [],
    newBySeverity: { CRITICAL: 1, HIGH: 0, MEDIUM: 0, LOW: 0, NONE: 0 },
    fixedBySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, NONE: 0 },
  },
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('quality-gate action', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('fails when delta gate detects new critical findings', async () => {
    // Inputs: mode='delta', summary-json provided, maxNewCritical=0
    vi.mocked(core.getInput).mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        mode: 'delta',
        'summary-json': JSON.stringify(baseSummary),
        'report-dir': '',
        'max-new-critical': '0',
        'max-new-high': '0',
        'max-new-medium': '-1',
        'max-critical': '',
        'max-high': '',
        'max-total': '',
        'max-p0': '0',
        'max-p1': '-1',
        ai: 'false',
      }
      return inputs[name] ?? ''
    })

    vi.mocked(core.getBooleanInput).mockImplementation((name: string) => {
      if (name === 'fail-on-p0') return true
      if (name === 'fail-on-p1') return false
      return false
    })

    vi.mocked(evaluateGates).mockReturnValue({
      result: 'fail',
      summary: '[delta] FAIL: Delta gate failed: 1 new critical findings exceed max 0',
      details: [
        {
          mode: 'delta',
          passed: false,
          reason: 'Delta gate failed: 1 new critical findings exceed max 0',
          data: { newCritical: 1, newHigh: 0, newMedium: 0 },
        },
      ],
    })

    await run()

    expect(evaluateGates).toHaveBeenCalledWith(
      ['delta'],
      baseSummary,
      expect.objectContaining({ maxNewCritical: 0 }),
    )
    expect(core.setOutput).toHaveBeenCalledWith('result', 'fail')
    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('Quality gate failed'),
    )
  })

  it('passes when triage allows P0 count within threshold', async () => {
    // Inputs: mode='triage-priority', maxP0=5 — P0 count is 2 so it passes
    vi.mocked(core.getInput).mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        mode: 'triage-priority',
        'summary-json': JSON.stringify(baseSummary),
        'report-dir': '',
        'max-new-critical': '0',
        'max-new-high': '0',
        'max-new-medium': '-1',
        'max-critical': '',
        'max-high': '',
        'max-total': '',
        'max-p0': '5',
        'max-p1': '-1',
        ai: 'false',
      }
      return inputs[name] ?? ''
    })

    vi.mocked(core.getBooleanInput).mockImplementation((name: string) => {
      if (name === 'fail-on-p0') return true
      if (name === 'fail-on-p1') return false
      return false
    })

    vi.mocked(evaluateGates).mockReturnValue({
      result: 'pass',
      summary: '[triage] PASS: Triage gate passed',
      details: [
        {
          mode: 'triage',
          passed: true,
          reason: 'Triage gate passed',
          data: { P0: 2, P1: 5 },
        },
      ],
    })

    await run()

    // 'triage-priority' should be mapped to 'triage' mode
    expect(evaluateGates).toHaveBeenCalledWith(
      ['triage'],
      baseSummary,
      expect.objectContaining({ maxP0: 5 }),
    )
    expect(core.setOutput).toHaveBeenCalledWith('result', 'pass')
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('fails overall when combined modes: delta passes but triage fails', async () => {
    // Mode: 'delta,triage-priority' — delta passes, triage fails → overall fail
    vi.mocked(core.getInput).mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        mode: 'delta,triage-priority',
        'summary-json': JSON.stringify(baseSummary),
        'report-dir': '',
        'max-new-critical': '-1',
        'max-new-high': '-1',
        'max-new-medium': '-1',
        'max-critical': '',
        'max-high': '',
        'max-total': '',
        'max-p0': '0',
        'max-p1': '-1',
        ai: 'false',
      }
      return inputs[name] ?? ''
    })

    vi.mocked(core.getBooleanInput).mockImplementation((name: string) => {
      if (name === 'fail-on-p0') return true
      if (name === 'fail-on-p1') return false
      return false
    })

    vi.mocked(evaluateGates).mockReturnValue({
      result: 'fail',
      summary:
        '[delta] PASS: Delta gate passed\n[triage] FAIL: Triage gate failed: 2 P0 findings exceed max 0',
      details: [
        {
          mode: 'delta',
          passed: true,
          reason: 'Delta gate passed',
          data: { newCritical: 1, newHigh: 0, newMedium: 0 },
        },
        {
          mode: 'triage',
          passed: false,
          reason: 'Triage gate failed: 2 P0 findings exceed max 0',
          data: { P0: 2, P1: 5 },
        },
      ],
    })

    await run()

    // Both modes should be passed, with triage-priority mapped to triage
    expect(evaluateGates).toHaveBeenCalledWith(
      ['delta', 'triage'],
      baseSummary,
      expect.any(Object),
    )
    expect(core.setOutput).toHaveBeenCalledWith('result', 'fail')
    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('Quality gate failed'),
    )
  })
})
