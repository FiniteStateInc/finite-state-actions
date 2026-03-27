import { describe, it, expect } from 'vitest'
import { evaluateGates } from '../src/gates'
import type { ReportSummary } from '../src/models'

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
      { findingId: 'CVE-2024-2222', severity: 'HIGH', risk: 75, component: 'curl@8.1.0' },
    ],
    fixedFindings: [
      { findingId: 'CVE-2023-3333', severity: 'HIGH', risk: 70, component: 'busybox@1.35' },
    ],
    newBySeverity: { CRITICAL: 1, HIGH: 1, MEDIUM: 0, LOW: 0, NONE: 0 },
    fixedBySeverity: { CRITICAL: 0, HIGH: 1, MEDIUM: 0, LOW: 0, NONE: 0 },
  },
}

// ── Delta mode ─────────────────────────────────────────────────────────────────

describe('delta mode', () => {
  it('fails when new critical > max (maxNewCritical: 0)', () => {
    const result = evaluateGates(['delta'], baseSummary, { maxNewCritical: 0 })
    expect(result.result).toBe('fail')
    const detail = result.details[0]
    expect(detail.passed).toBe(false)
    expect(detail.reason.toLowerCase()).toContain('critical')
  })

  it('passes when within limits (maxNewCritical: 5, maxNewHigh: 5)', () => {
    const result = evaluateGates(['delta'], baseSummary, { maxNewCritical: 5, maxNewHigh: 5 })
    expect(result.result).toBe('pass')
    expect(result.details[0].passed).toBe(true)
  })

  it('treats -1 as unlimited', () => {
    const result = evaluateGates(['delta'], baseSummary, {
      maxNewCritical: -1,
      maxNewHigh: -1,
      maxNewMedium: -1,
    })
    expect(result.result).toBe('pass')
    expect(result.details[0].passed).toBe(true)
  })
})

// ── Threshold mode ─────────────────────────────────────────────────────────────

describe('threshold mode', () => {
  it('fails when total critical > max (maxCritical: 1), reason contains "2 critical"', () => {
    const result = evaluateGates(['threshold'], baseSummary, { maxCritical: 1 })
    expect(result.result).toBe('fail')
    const detail = result.details[0]
    expect(detail.passed).toBe(false)
    expect(detail.reason).toContain('2 critical')
  })

  it('fails when total findings > max (maxTotal: 40)', () => {
    const result = evaluateGates(['threshold'], baseSummary, { maxTotal: 40 })
    expect(result.result).toBe('fail')
    const detail = result.details[0]
    expect(detail.passed).toBe(false)
    expect(detail.reason).toContain('48')
  })

  it('passes when all within limits', () => {
    const result = evaluateGates(['threshold'], baseSummary, {
      maxCritical: 5,
      maxHigh: 15,
      maxTotal: 100,
    })
    expect(result.result).toBe('pass')
    expect(result.details[0].passed).toBe(true)
  })
})

// ── Triage priority mode ───────────────────────────────────────────────────────

describe('triage mode', () => {
  it('fails when P0 > maxP0 (failOnP0: true, maxP0: 0), reason contains "P0"', () => {
    const result = evaluateGates(['triage'], baseSummary, { failOnP0: true, maxP0: 0 })
    expect(result.result).toBe('fail')
    const detail = result.details[0]
    expect(detail.passed).toBe(false)
    expect(detail.reason).toContain('P0')
  })

  it('passes when P0 within max (maxP0: 5)', () => {
    const result = evaluateGates(['triage'], baseSummary, { failOnP0: true, maxP0: 5 })
    expect(result.result).toBe('pass')
    expect(result.details[0].passed).toBe(true)
  })

  it('checks P1 when failOnP1: true (maxP1: 2), reason contains "P1"', () => {
    const result = evaluateGates(['triage'], baseSummary, { failOnP1: true, maxP1: 2 })
    expect(result.result).toBe('fail')
    const detail = result.details[0]
    expect(detail.passed).toBe(false)
    expect(detail.reason).toContain('P1')
  })
})

// ── Combined modes ─────────────────────────────────────────────────────────────

describe('combined modes', () => {
  it('delta passes (5 max) + triage fails (0 max P0) = overall fail, details has length 2', () => {
    const result = evaluateGates(['delta', 'triage'], baseSummary, {
      maxNewCritical: 5,
      maxNewHigh: 5,
      failOnP0: true,
      maxP0: 0,
    })
    expect(result.result).toBe('fail')
    expect(result.details).toHaveLength(2)

    const deltaDetail = result.details.find((d) => d.mode === 'delta')
    const triageDetail = result.details.find((d) => d.mode === 'triage')

    expect(deltaDetail?.passed).toBe(true)
    expect(triageDetail?.passed).toBe(false)
  })
})
