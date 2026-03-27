import { describe, it, expect } from 'vitest'
import {
  Severity,
  ScanType,
  ScanStatus,
  PriorityBand,
  severityOrder,
  parseSeverityList,
  riskToCvss,
} from '../src/models'

describe('severityOrder', () => {
  it('ranks CRITICAL highest', () => {
    expect(severityOrder('CRITICAL')).toBeGreaterThan(severityOrder('HIGH'))
    expect(severityOrder('HIGH')).toBeGreaterThan(severityOrder('MEDIUM'))
    expect(severityOrder('MEDIUM')).toBeGreaterThan(severityOrder('LOW'))
    expect(severityOrder('LOW')).toBeGreaterThan(severityOrder('NONE'))
  })
})

describe('parseSeverityList', () => {
  it('parses comma-separated severity string', () => {
    expect(parseSeverityList('critical,high')).toEqual(['CRITICAL', 'HIGH'])
  })

  it('trims whitespace and normalizes case', () => {
    expect(parseSeverityList(' Critical , HIGH , low ')).toEqual(['CRITICAL', 'HIGH', 'LOW'])
  })

  it('returns empty array for empty string', () => {
    expect(parseSeverityList('')).toEqual([])
  })
})

describe('riskToCvss', () => {
  it('converts 0-100 risk to 0-10 CVSS', () => {
    expect(riskToCvss(98)).toBe(9.8)
    expect(riskToCvss(0)).toBe(0)
    expect(riskToCvss(55)).toBe(5.5)
  })
})
