// ── Enums / Union Types ────────────────────────────────────────────────────────

export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE'

export type ScanType =
  | 'sca'
  | 'sast'
  | 'config'
  | 'vulnerability-analysis'
  | 'sbom'
  | 'third-party'

export type ScanStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'

export type VexStatus =
  | 'not_affected'
  | 'affected'
  | 'fixed'
  | 'under_investigation'

export type PriorityBand = 'P0' | 'P1' | 'P2' | 'P3'

export type GateMode = 'severity' | 'risk' | 'epss' | 'kev' | 'count'

export type SbomFormat = 'cyclonedx' | 'spdx'

// ── Entity Types ───────────────────────────────────────────────────────────────

export interface AuthUser {
  id: string
  email: string
  organizationId: string
}

export interface Project {
  id: string
  name: string
  description?: string
  organizationId: string
}

export interface Version {
  id: string
  name: string
  projectId: string
  createdAt: string
}

export interface Finding {
  id: number
  findingId: string
  severity: Severity
  risk: number // 0–100
  reachabilityScore?: number
  attackVector?: string
  epss_score?: number
  epss_percentile?: number
  inKev: boolean
  component: {
    name: string
    version: string
    purl?: string
  }
  project: {
    id: string
    name: string
  }
  projectVersion: {
    id: string
    name: string
  }
}

export interface Scan {
  id: string
  scanType: ScanType
  status: ScanStatus
  createdAt: string
  completedAt?: string
  versionId: string
}

// ── Report / Summary Types ─────────────────────────────────────────────────────

export interface SeverityCounts {
  CRITICAL: number
  HIGH: number
  MEDIUM: number
  LOW: number
  NONE: number
}

export interface TriageFinding {
  findingId: string
  severity: Severity
  risk: number
  component: string
  title?: string
}

export interface TriageBands {
  P0: number
  P1: number
  P2: number
  P3: number
  topFindings: TriageFinding[]
}

export interface DeltaFinding {
  findingId: string
  severity: Severity
  risk: number
  component: string
}

export interface VersionDelta {
  newFindings: DeltaFinding[]
  fixedFindings: DeltaFinding[]
  newBySeverity: SeverityCounts
  fixedBySeverity: SeverityCounts
}

export interface ReportSummary {
  severityCounts: SeverityCounts
  triageBands?: TriageBands
  versionDelta?: VersionDelta
  totalFindings: number
}

// ── Gate Types ─────────────────────────────────────────────────────────────────

export interface GateModeResult {
  mode: GateMode
  passed: boolean
  reason: string
}

export interface GateResult {
  result: 'pass' | 'fail'
  summary: string
  details: GateModeResult[]
}

// ── Setup / Context ────────────────────────────────────────────────────────────

export interface SetupContext {
  apiUrl: string
  token: string
  organizationId: string
}

// ── Helper Functions ───────────────────────────────────────────────────────────

const SEVERITY_RANK: Record<Severity, number> = {
  NONE: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
}

/**
 * Returns a numeric rank for a severity level (higher = more severe).
 */
export function severityOrder(severity: Severity): number {
  return SEVERITY_RANK[severity] ?? -1
}

/**
 * Parses a comma-separated string of severity labels into a typed array.
 * Trims whitespace and normalises to uppercase.
 */
export function parseSeverityList(input: string): Severity[] {
  if (!input.trim()) return []
  return input
    .split(',')
    .map((s) => s.trim().toUpperCase() as Severity)
    .filter((s) => s in SEVERITY_RANK)
}

/**
 * Converts a 0–100 risk score to a 0.0–10.0 CVSS-style score.
 */
export function riskToCvss(risk: number): number {
  return Math.round(risk) / 10
}
