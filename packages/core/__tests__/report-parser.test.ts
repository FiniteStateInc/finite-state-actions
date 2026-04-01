import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  parseTriageCsv,
  parseVersionComparisonCsv,
  parseFindingsSummaryJson,
} from '../src/report-parser'

const fixturesDir = join(__dirname, 'fixtures')

function fixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8')
}

describe('parseTriageCsv', () => {
  it('counts each priority band correctly', () => {
    const result = parseTriageCsv(fixture('triage-prioritization.csv'))
    expect(result.P0).toBe(1)
    expect(result.P1).toBe(1)
    expect(result.P2).toBe(1)
    expect(result.P3).toBe(1)
  })

  it('collects P0 and P1 as topFindings (2 entries)', () => {
    const result = parseTriageCsv(fixture('triage-prioritization.csv'))
    expect(result.topFindings).toHaveLength(2)
  })

  it('first topFinding is CVE-2024-1234 with band P0', () => {
    const result = parseTriageCsv(fixture('triage-prioritization.csv'))
    expect(result.topFindings[0].findingId).toBe('CVE-2024-1234')
    expect(result.topFindings[0].severity).toBe('CRITICAL')
  })
})

describe('parseVersionComparisonCsv', () => {
  it('splits into 2 new findings and 1 fixed finding', () => {
    const result = parseVersionComparisonCsv(fixture('version-comparison.csv'))
    expect(result.newFindings).toHaveLength(2)
    expect(result.fixedFindings).toHaveLength(1)
  })

  it('counts new findings by severity: CRITICAL=1', () => {
    const result = parseVersionComparisonCsv(fixture('version-comparison.csv'))
    expect(result.newBySeverity.CRITICAL).toBe(1)
  })

  it('counts fixed findings by severity: HIGH=1', () => {
    const result = parseVersionComparisonCsv(fixture('version-comparison.csv'))
    expect(result.fixedBySeverity.HIGH).toBe(1)
  })
})

describe('parseFindingsSummaryJson', () => {
  it('extracts CRITICAL count as 5', () => {
    const result = parseFindingsSummaryJson(fixture('findings-summary.json'))
    expect(result.severityCounts.CRITICAL).toBe(5)
  })

  it('extracts totalFindings as 85', () => {
    const result = parseFindingsSummaryJson(fixture('findings-summary.json'))
    expect(result.totalFindings).toBe(85)
  })
})
