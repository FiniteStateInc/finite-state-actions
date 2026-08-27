import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  parseCsvRows,
  parseTriageCsv,
  parseVersionComparisonCsv,
  parseSeverityCounts,
} from '../src/report-parser'

const fixturesDir = join(__dirname, 'fixtures')

function fixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8')
}

describe('parseCsvRows', () => {
  it('keeps a quoted field with an embedded comma in one column', () => {
    const rows = parseCsvRows('a,b,c\n1,"two, and a half",3\n')
    expect(rows).toHaveLength(1)
    expect(rows[0].b).toBe('two, and a half')
    expect(rows[0].c).toBe('3')
  })

  it('unescapes doubled quotes and handles CRLF', () => {
    const rows = parseCsvRows('a,b\r\n1,"say ""hi"""\r\n')
    expect(rows[0].b).toBe('say "hi"')
  })
})

describe('parseTriageCsv', () => {
  it('maps fs-report severity bands onto P0-P3', () => {
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
    expect(result.topFindings[0].risk).toBe(95)
    expect(result.topFindings[0].component).toBe('openssl')
  })

  it('ignores the INFO band, which has no P-band equivalent', () => {
    const result = parseTriageCsv(fixture('triage-prioritization.csv'))
    expect(result.P0 + result.P1 + result.P2 + result.P3).toBe(4)
  })

  it('still reads a scoring-file that names its bands P0-P3 directly', () => {
    const result = parseTriageCsv(
      'finding_id,severity,priority_band\nCVE-1,HIGH,P1\nCVE-2,LOW,P3\n',
    )
    expect(result.P1).toBe(1)
    expect(result.P3).toBe(1)
  })
})

describe('parseVersionComparisonCsv', () => {
  it('splits the findings-churn table into 2 new and 1 fixed', () => {
    const result = parseVersionComparisonCsv(fixture('version-comparison-churn.csv'))
    expect(result.newFindings).toHaveLength(2)
    expect(result.fixedFindings).toHaveLength(1)
  })

  it('counts new findings by severity: CRITICAL=1', () => {
    const result = parseVersionComparisonCsv(fixture('version-comparison-churn.csv'))
    expect(result.newBySeverity.CRITICAL).toBe(1)
  })

  it('counts fixed findings by severity: HIGH=1', () => {
    const result = parseVersionComparisonCsv(fixture('version-comparison-churn.csv'))
    expect(result.fixedBySeverity.HIGH).toBe(1)
  })

  it('reads ID and Component Name, not CVE ID and Component', () => {
    const result = parseVersionComparisonCsv(fixture('version-comparison-churn.csv'))
    expect(result.newFindings[0].findingId).toBe('CVE-2024-1111')
    expect(result.newFindings[0].component).toBe('openssl')
  })
})

describe('parseSeverityCounts', () => {
  it('counts the Severity column of Findings by Project', () => {
    const result = parseSeverityCounts(fixture('findings-by-project.csv'))
    expect(result.severityCounts).toEqual({
      CRITICAL: 1,
      HIGH: 1,
      MEDIUM: 1,
      LOW: 1,
      NONE: 0,
    })
    expect(result.totalFindings).toBe(4)
  })

  it('also counts the lowercase severity column of Triage Prioritization', () => {
    const result = parseSeverityCounts(fixture('triage-prioritization.csv'))
    expect(result.severityCounts.CRITICAL).toBe(1)
    expect(result.totalFindings).toBe(5)
  })
})
