import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type {
  TriageBands,
  TriageFinding,
  VersionDelta,
  DeltaFinding,
  ReportSummary,
  SeverityCounts,
  Severity,
} from './models'

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Parse a CSV string into an array of row objects keyed by header name.
 * Handles standard comma-separated values with a header row.
 */
export function parseCsvRows(csv: string): Record<string, string>[] {
  const lines = csv.trim().split('\n').filter((l) => l.trim().length > 0)
  if (lines.length < 2) return []

  const headers = lines[0].split(',').map((h) => h.trim())
  const rows: Record<string, string>[] = []

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',').map((v) => v.trim())
    const row: Record<string, string> = {}
    headers.forEach((header, idx) => {
      row[header] = values[idx] ?? ''
    })
    rows.push(row)
  }

  return rows
}

function emptySeverityCounts(): SeverityCounts {
  return { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, NONE: 0 }
}

function incrementSeverity(counts: SeverityCounts, severity: string): void {
  const key = severity.toUpperCase() as Severity
  if (key in counts) {
    counts[key]++
  }
}

// ── Parsers ────────────────────────────────────────────────────────────────────

/**
 * Parse a Triage Prioritization CSV into TriageBands.
 * Counts each priority band and collects P0/P1 entries as topFindings.
 */
export function parseTriageCsv(csv: string): TriageBands {
  const rows = parseCsvRows(csv)

  const bands: TriageBands = {
    P0: 0,
    P1: 0,
    P2: 0,
    P3: 0,
    topFindings: [],
  }

  for (const row of rows) {
    const band = row['Priority Band']?.trim() as 'P0' | 'P1' | 'P2' | 'P3' | undefined
    if (band && band in bands) {
      (bands[band] as number)++
    }

    if (band === 'P0' || band === 'P1') {
      const finding: TriageFinding = {
        findingId: row['CVE ID'] ?? '',
        severity: (row['Severity']?.toUpperCase() ?? 'NONE') as Severity,
        risk: 0,
        component: row['Component'] ?? '',
      }
      bands.topFindings.push(finding)
    }
  }

  // Sort topFindings: P0 before P1
  bands.topFindings.sort((a, b) => {
    const bandOf = (f: TriageFinding): string => {
      const r = rows.find((row) => row['CVE ID'] === f.findingId)
      return r?.['Priority Band'] ?? ''
    }
    return bandOf(a).localeCompare(bandOf(b))
  })

  return bands
}

/**
 * Parse a Version Comparison CSV into a VersionDelta.
 * Splits rows into new/fixed findings and counts each group by severity.
 */
export function parseVersionComparisonCsv(csv: string): VersionDelta {
  const rows = parseCsvRows(csv)

  const newFindings: DeltaFinding[] = []
  const fixedFindings: DeltaFinding[] = []
  const newBySeverity = emptySeverityCounts()
  const fixedBySeverity = emptySeverityCounts()

  for (const row of rows) {
    const changeType = row['Change Type']?.trim().toUpperCase()
    const finding: DeltaFinding = {
      findingId: row['CVE ID'] ?? '',
      severity: (row['Severity']?.toUpperCase() ?? 'NONE') as Severity,
      risk: 0,
      component: row['Component'] ?? '',
    }

    if (changeType === 'NEW') {
      newFindings.push(finding)
      incrementSeverity(newBySeverity, finding.severity)
    } else if (changeType === 'FIXED') {
      fixedFindings.push(finding)
      incrementSeverity(fixedBySeverity, finding.severity)
    }
  }

  return { newFindings, fixedFindings, newBySeverity, fixedBySeverity }
}

/**
 * Parse a findings_summary.json string into a ReportSummary.
 * Expects { bySeverity: {...}, total: number }.
 */
export function parseFindingsSummaryJson(json: string): ReportSummary {
  const data = JSON.parse(json) as {
    bySeverity: Partial<SeverityCounts>
    total: number
  }

  const severityCounts: SeverityCounts = {
    CRITICAL: data.bySeverity.CRITICAL ?? 0,
    HIGH: data.bySeverity.HIGH ?? 0,
    MEDIUM: data.bySeverity.MEDIUM ?? 0,
    LOW: data.bySeverity.LOW ?? 0,
    NONE: data.bySeverity.NONE ?? 0,
  }

  return {
    severityCounts,
    totalFindings: data.total,
  }
}

/**
 * Read a standard fs-report output directory and return a combined ReportSummary.
 * Reads:
 *   {dir}/Triage Prioritization/Triage Prioritization.csv
 *   {dir}/Version Comparison/Version Comparison.csv
 *   {dir}/findings_summary.json
 */
export function parseReportDirectory(reportDir: string): ReportSummary {
  const triagePath = join(reportDir, 'Triage Prioritization', 'Triage Prioritization.csv')
  const versionPath = join(reportDir, 'Version Comparison', 'Version Comparison.csv')
  const summaryPath = join(reportDir, 'findings_summary.json')

  let summary: ReportSummary = {
    severityCounts: emptySeverityCounts(),
    totalFindings: 0,
  }

  if (existsSync(summaryPath)) {
    summary = parseFindingsSummaryJson(readFileSync(summaryPath, 'utf-8'))
  }

  if (existsSync(triagePath)) {
    summary.triageBands = parseTriageCsv(readFileSync(triagePath, 'utf-8'))
  }

  if (existsSync(versionPath)) {
    summary.versionDelta = parseVersionComparisonCsv(readFileSync(versionPath, 'utf-8'))
  }

  return summary
}
