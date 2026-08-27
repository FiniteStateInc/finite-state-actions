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
  PriorityBand,
} from './models'

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Parse a CSV string into an array of row objects keyed by header name.
 *
 * fs-report writes its CSVs with pandas `to_csv`, so free-text columns
 * (`Title`, `Description`, `ai_guidance`, …) arrive double-quoted with
 * embedded commas, newlines and doubled quotes. A naive `split(',')` shears
 * those rows apart and misaligns every later column, so this walks the text
 * character by character instead.
 */
export function parseCsvRows(csv: string): Record<string, string>[] {
  const records: string[][] = []
  let field = ''
  let record: string[] = []
  let inQuotes = false

  const endField = (): void => {
    record.push(field)
    field = ''
  }
  const endRecord = (): void => {
    endField()
    records.push(record)
    record = []
  }

  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i]

    if (inQuotes) {
      if (ch === '"') {
        if (csv[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
      continue
    }

    if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      endField()
    } else if (ch === '\n') {
      endRecord()
    } else if (ch === '\r') {
      // CRLF — the \n that follows closes the record
    } else {
      field += ch
    }
  }
  // A trailing newline leaves an empty pending record; a missing one does not.
  if (field.length > 0 || record.length > 0) endRecord()

  const nonEmpty = records.filter((r) => r.some((v) => v.trim().length > 0))
  if (nonEmpty.length < 2) return []

  const headers = nonEmpty[0].map((h) => h.trim())
  return nonEmpty.slice(1).map((values) => {
    const row: Record<string, string> = {}
    headers.forEach((header, idx) => {
      row[header] = values[idx] ?? ''
    })
    return row
  })
}

/** Read the first present column from a row, tolerating header renames. */
function pick(row: Record<string, string>, ...names: string[]): string {
  for (const name of names) {
    const value = row[name]
    if (value !== undefined && value.trim().length > 0) return value.trim()
  }
  return ''
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

function normalizeSeverity(raw: string): Severity {
  const key = raw.toUpperCase()
  return (key in emptySeverityCounts() ? key : 'NONE') as Severity
}

/**
 * fs-report's Triage Prioritization transform emits severity-style band names
 * (`BAND_ORDER = CRITICAL, HIGH, MEDIUM, LOW, INFO`), while this repo's gates
 * and PR comments are expressed in P0–P3. Map the four gateable bands and drop
 * INFO, which has no P-band equivalent. A `--scoring-file` that names its bands
 * P0–P3 directly is passed through unchanged.
 */
const BAND_TO_PRIORITY: Record<string, PriorityBand> = {
  CRITICAL: 'P0',
  HIGH: 'P1',
  MEDIUM: 'P2',
  LOW: 'P3',
  P0: 'P0',
  P1: 'P1',
  P2: 'P2',
  P3: 'P3',
}

const PRIORITY_RANK: Record<PriorityBand, number> = { P0: 0, P1: 1, P2: 2, P3: 3 }

// ── Parsers ────────────────────────────────────────────────────────────────────

/**
 * Parse a Triage Prioritization CSV into TriageBands.
 * Counts each priority band and collects P0/P1 entries as topFindings.
 *
 * Columns come from `triage_prioritization_transform`'s `output_columns`, which
 * are snake_case (`priority_band`, `finding_id`, `component_name`, …).
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

  const ranked: { band: PriorityBand; finding: TriageFinding }[] = []

  for (const row of rows) {
    const rawBand = pick(row, 'priority_band', 'Priority Band').toUpperCase()
    const band = BAND_TO_PRIORITY[rawBand]
    if (!band) continue

    bands[band]++

    if (band === 'P0' || band === 'P1') {
      ranked.push({
        band,
        finding: {
          findingId: pick(row, 'finding_id', 'CVE ID', 'ID'),
          severity: normalizeSeverity(pick(row, 'severity', 'Severity')),
          risk: Number(pick(row, 'risk', 'triage_score')) || 0,
          component: pick(row, 'component_name', 'Component Name', 'Component'),
        },
      })
    }
  }

  ranked.sort((a, b) => PRIORITY_RANK[a.band] - PRIORITY_RANK[b.band])
  bands.topFindings = ranked.map((r) => r.finding)

  return bands
}

/**
 * Parse a Version Comparison findings-churn CSV into a VersionDelta.
 *
 * This is the `<recipe>_Detail_Findings_Churn.csv` sibling file, not the main
 * `Version Comparison.csv` — the main file is the per-version summary table
 * (Project/Version/Total Findings/…) and carries no per-finding rows.
 * `Change Type` is `New` or `Fixed`.
 */
export function parseVersionComparisonCsv(csv: string): VersionDelta {
  const rows = parseCsvRows(csv)

  const newFindings: DeltaFinding[] = []
  const fixedFindings: DeltaFinding[] = []
  const newBySeverity = emptySeverityCounts()
  const fixedBySeverity = emptySeverityCounts()

  for (const row of rows) {
    const changeType = pick(row, 'Change Type', 'change_type').toUpperCase()
    const finding: DeltaFinding = {
      findingId: pick(row, 'ID', 'CVE ID', 'finding_id'),
      severity: normalizeSeverity(pick(row, 'Severity', 'severity')),
      risk: Number(pick(row, 'Score', 'risk')) || 0,
      component: pick(row, 'Component Name', 'Component', 'component_name'),
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
 * Count a findings CSV's `severity` column into a SeverityCounts.
 * Works on both `Findings by Project.csv` (`Severity`) and
 * `Triage Prioritization.csv` (`severity`).
 */
export function parseSeverityCounts(csv: string): {
  severityCounts: SeverityCounts
  totalFindings: number
} {
  const rows = parseCsvRows(csv)
  const severityCounts = emptySeverityCounts()

  for (const row of rows) {
    incrementSeverity(severityCounts, pick(row, 'Severity', 'severity'))
  }

  return { severityCounts, totalFindings: rows.length }
}

/**
 * Read an fs-report output directory and return a combined ReportSummary.
 *
 * `fs-report run --headless --output <dir>` writes one subdirectory per recipe,
 * named after the recipe, with files sharing that base name — so:
 *   {dir}/Triage Prioritization/Triage Prioritization.csv
 *   {dir}/Version Comparison/Version Comparison_Detail_Findings_Churn.csv
 *   {dir}/Findings by Project/Findings by Project.csv
 *
 * Severity counts come from Findings by Project when that recipe ran (it is the
 * full inventory) and fall back to Triage Prioritization otherwise. fs-report
 * writes no aggregate summary file, so there is nothing else to read.
 */
export function parseReportDirectory(reportDir: string): ReportSummary {
  const triagePath = join(reportDir, 'Triage Prioritization', 'Triage Prioritization.csv')
  const churnPath = join(
    reportDir,
    'Version Comparison',
    'Version Comparison_Detail_Findings_Churn.csv',
  )
  const findingsPath = join(reportDir, 'Findings by Project', 'Findings by Project.csv')

  const summary: ReportSummary = {
    severityCounts: emptySeverityCounts(),
    totalFindings: 0,
  }

  const severitySource = existsSync(findingsPath)
    ? findingsPath
    : existsSync(triagePath)
      ? triagePath
      : undefined

  if (severitySource) {
    const counted = parseSeverityCounts(readFileSync(severitySource, 'utf-8'))
    summary.severityCounts = counted.severityCounts
    summary.totalFindings = counted.totalFindings
  }

  if (existsSync(triagePath)) {
    summary.triageBands = parseTriageCsv(readFileSync(triagePath, 'utf-8'))
  }

  if (existsSync(churnPath)) {
    summary.versionDelta = parseVersionComparisonCsv(readFileSync(churnPath, 'utf-8'))
  }

  return summary
}
