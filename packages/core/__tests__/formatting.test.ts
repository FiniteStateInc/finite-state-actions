import { describe, it, expect } from 'vitest'
import {
  renderSummaryComment,
  renderTriageComment,
  renderComparisonComment,
} from '../src/formatting'
import type { ReportSummary, GateResult } from '../src/models'

const baseSummary: ReportSummary = {
  severityCounts: { CRITICAL: 2, HIGH: 10, MEDIUM: 30, LOW: 5, NONE: 1 },
  totalFindings: 48,
  triageBands: {
    P0: 1,
    P1: 3,
    P2: 15,
    P3: 29,
    topFindings: [
      {
        findingId: 'CVE-2024-1234',
        component: 'openssl@3.0.2',
        severity: 'CRITICAL',
        risk: 95,
      },
    ],
  },
  versionDelta: {
    newFindings: [
      { findingId: 'CVE-2024-1111', severity: 'CRITICAL', risk: 90, component: 'openssl@3.0.2' },
    ],
    fixedFindings: [
      { findingId: 'CVE-2023-3333', severity: 'HIGH', risk: 70, component: 'busybox@1.35' },
    ],
    newBySeverity: { CRITICAL: 1, HIGH: 0, MEDIUM: 0, LOW: 0, NONE: 0 },
    fixedBySeverity: { CRITICAL: 0, HIGH: 1, MEDIUM: 0, LOW: 0, NONE: 0 },
  },
}

const passGate: GateResult = {
  result: 'pass',
  summary: 'All gates passed',
  details: [],
}

const failGate: GateResult = {
  result: 'fail',
  summary: 'delta: FAIL — 1 new critical findings (max: 0)',
  details: [],
}

// ── renderSummaryComment ───────────────────────────────────────────────────────

describe('renderSummaryComment', () => {
  it('includes the default comment tag marker', () => {
    const output = renderSummaryComment(baseSummary)
    expect(output).toContain('<!-- finite-state -->')
  })

  it('includes a custom comment tag marker when provided', () => {
    const output = renderSummaryComment(baseSummary, undefined, 'my-bot')
    expect(output).toContain('<!-- my-bot -->')
    expect(output).not.toContain('<!-- finite-state -->')
  })

  it('includes the correct header', () => {
    const output = renderSummaryComment(baseSummary)
    expect(output).toContain('## Finite State Security Report')
  })

  it('includes severity table with correct counts', () => {
    const output = renderSummaryComment(baseSummary)
    expect(output).toContain('CRITICAL')
    expect(output).toContain('2')
    expect(output).toContain('HIGH')
    expect(output).toContain('10')
    expect(output).toContain('MEDIUM')
    expect(output).toContain('30')
    expect(output).toContain('LOW')
    expect(output).toContain('5')
    // Total
    expect(output).toContain('48')
  })

  it('shows PASSED for a passing gate', () => {
    const output = renderSummaryComment(baseSummary, passGate)
    expect(output).toContain('PASSED')
    expect(output).toContain('All gates passed')
  })

  it('shows FAILED for a failing gate', () => {
    const output = renderSummaryComment(baseSummary, failGate)
    expect(output).toContain('FAILED')
    expect(output).toContain('delta: FAIL')
  })

  it('includes pass/fail icon in header when gate provided', () => {
    const passOutput = renderSummaryComment(baseSummary, passGate)
    const failOutput = renderSummaryComment(baseSummary, failGate)
    // Header should differ between pass and fail
    expect(passOutput).not.toEqual(failOutput)
  })

  it('omits gate section when no gate provided', () => {
    const output = renderSummaryComment(baseSummary)
    expect(output).not.toContain('Quality Gate')
  })
})

// ── renderTriageComment ────────────────────────────────────────────────────────

describe('renderTriageComment', () => {
  it('includes the default comment tag marker', () => {
    const output = renderTriageComment(baseSummary)
    expect(output).toContain('<!-- finite-state -->')
  })

  it('includes the correct header', () => {
    const output = renderTriageComment(baseSummary)
    expect(output).toContain('## Finite State Triage Report')
  })

  it('includes P0/P1/P2/P3 counts in priority band table', () => {
    const output = renderTriageComment(baseSummary)
    expect(output).toContain('P0')
    expect(output).toContain('P1')
    expect(output).toContain('P2')
    expect(output).toContain('P3')
    expect(output).toContain('1') // P0 count
    expect(output).toContain('3') // P1 count
    expect(output).toContain('15') // P2 count
    expect(output).toContain('29') // P3 count
  })

  it('lists top P0/P1 findings with CVE ID and component', () => {
    const output = renderTriageComment(baseSummary)
    expect(output).toContain('CVE-2024-1234')
    expect(output).toContain('openssl@3.0.2')
  })

  it('includes Top Priority Findings section', () => {
    const output = renderTriageComment(baseSummary)
    expect(output).toContain('Top Priority Findings')
  })

  it('shows gate result when provided', () => {
    const output = renderTriageComment(baseSummary, failGate)
    expect(output).toContain('FAILED')
    expect(output).toContain('delta: FAIL')
  })

  it('works when triageBands is absent', () => {
    const summaryNoTriage: ReportSummary = {
      severityCounts: { CRITICAL: 1, HIGH: 2, MEDIUM: 3, LOW: 4, NONE: 0 },
      totalFindings: 10,
    }
    const output = renderTriageComment(summaryNoTriage)
    expect(output).toContain('## Finite State Triage Report')
  })
})

// ── renderComparisonComment ────────────────────────────────────────────────────

describe('renderComparisonComment', () => {
  it('includes the default comment tag marker', () => {
    const output = renderComparisonComment(baseSummary)
    expect(output).toContain('<!-- finite-state -->')
  })

  it('includes the correct header', () => {
    const output = renderComparisonComment(baseSummary)
    expect(output).toContain('## Finite State Version Comparison')
  })

  it('includes delta table with New and Fixed columns', () => {
    const output = renderComparisonComment(baseSummary)
    expect(output).toContain('New')
    expect(output).toContain('Fixed')
    expect(output).toContain('CRITICAL')
    expect(output).toContain('HIGH')
  })

  it('includes New Findings section with count and list', () => {
    const output = renderComparisonComment(baseSummary)
    expect(output).toContain('New Findings')
    expect(output).toContain('CVE-2024-1111')
    expect(output).toContain('openssl@3.0.2')
  })

  it('includes Fixed Findings section with count and list', () => {
    const output = renderComparisonComment(baseSummary)
    expect(output).toContain('Fixed Findings')
    expect(output).toContain('CVE-2023-3333')
    expect(output).toContain('busybox@1.35')
  })

  it('shows gate result when provided', () => {
    const output = renderComparisonComment(baseSummary, passGate)
    expect(output).toContain('PASSED')
    expect(output).toContain('All gates passed')
  })

  it('works when versionDelta is absent', () => {
    const summaryNoDelta: ReportSummary = {
      severityCounts: { CRITICAL: 1, HIGH: 2, MEDIUM: 3, LOW: 4, NONE: 0 },
      totalFindings: 10,
    }
    const output = renderComparisonComment(summaryNoDelta)
    expect(output).toContain('## Finite State Version Comparison')
  })
})
