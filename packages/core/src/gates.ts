import type { GateMode, GateModeResult, GateResult, ReportSummary } from './models'

export interface GateOptions {
  // Delta mode
  maxNewCritical?: number
  maxNewHigh?: number
  maxNewMedium?: number
  // Threshold mode
  maxCritical?: number
  maxHigh?: number
  maxTotal?: number
  // Triage priority mode
  failOnP0?: boolean
  failOnP1?: boolean
  maxP0?: number
  maxP1?: number
}

/**
 * Evaluate a single delta gate mode.
 * Compares new findings from versionDelta against configured max thresholds.
 * -1 means unlimited. If no versionDelta data, passes with a note.
 */
function evaluateDelta(summary: ReportSummary, options: GateOptions): GateModeResult {
  if (!summary.versionDelta) {
    return {
      mode: 'delta',
      passed: true,
      reason: 'No version delta data available; delta gate skipped',
      data: {},
    }
  }

  const { newBySeverity } = summary.versionDelta
  const failures: string[] = []
  const data: Record<string, unknown> = {
    newCritical: newBySeverity.CRITICAL,
    newHigh: newBySeverity.HIGH,
    newMedium: newBySeverity.MEDIUM,
  }

  const { maxNewCritical, maxNewHigh, maxNewMedium } = options

  if (
    maxNewCritical !== undefined &&
    maxNewCritical !== -1 &&
    newBySeverity.CRITICAL > maxNewCritical
  ) {
    failures.push(`${newBySeverity.CRITICAL} new critical findings exceed max ${maxNewCritical}`)
  }
  if (maxNewHigh !== undefined && maxNewHigh !== -1 && newBySeverity.HIGH > maxNewHigh) {
    failures.push(`${newBySeverity.HIGH} new high findings exceed max ${maxNewHigh}`)
  }
  if (maxNewMedium !== undefined && maxNewMedium !== -1 && newBySeverity.MEDIUM > maxNewMedium) {
    failures.push(`${newBySeverity.MEDIUM} new medium findings exceed max ${maxNewMedium}`)
  }

  if (failures.length > 0) {
    return {
      mode: 'delta',
      passed: false,
      reason: `Delta gate failed: ${failures.join('; ')}`,
      data,
    }
  }

  return {
    mode: 'delta',
    passed: true,
    reason: 'Delta gate passed',
    data,
  }
}

/**
 * Evaluate a single threshold gate mode.
 * Compares total severity counts and total findings against configured maxes.
 */
function evaluateThreshold(summary: ReportSummary, options: GateOptions): GateModeResult {
  const { severityCounts, totalFindings } = summary
  const failures: string[] = []
  const data: Record<string, unknown> = {
    critical: severityCounts.CRITICAL,
    high: severityCounts.HIGH,
    total: totalFindings,
  }

  const { maxCritical, maxHigh, maxTotal } = options

  if (maxCritical !== undefined && severityCounts.CRITICAL > maxCritical) {
    failures.push(`${severityCounts.CRITICAL} critical findings exceed max ${maxCritical}`)
  }
  if (maxHigh !== undefined && severityCounts.HIGH > maxHigh) {
    failures.push(`${severityCounts.HIGH} high findings exceed max ${maxHigh}`)
  }
  if (maxTotal !== undefined && totalFindings > maxTotal) {
    failures.push(`${totalFindings} total findings exceed max ${maxTotal}`)
  }

  if (failures.length > 0) {
    return {
      mode: 'threshold',
      passed: false,
      reason: `Threshold gate failed: ${failures.join('; ')}`,
      data,
    }
  }

  return {
    mode: 'threshold',
    passed: true,
    reason: 'Threshold gate passed',
    data,
  }
}

/**
 * Evaluate a single triage-priority gate mode.
 * Checks P0/P1 counts from triageBands against maxP0/maxP1, gated by failOnP0/failOnP1.
 * If no triageBands data, passes with a note.
 */
function evaluateTriage(summary: ReportSummary, options: GateOptions): GateModeResult {
  if (!summary.triageBands) {
    return {
      mode: 'triage',
      passed: true,
      reason: 'No triage bands data available; triage gate skipped',
      data: {},
    }
  }

  const { P0, P1 } = summary.triageBands
  const failures: string[] = []
  const data: Record<string, unknown> = { P0, P1 }

  const { failOnP0, failOnP1, maxP0, maxP1 } = options

  if (failOnP0 && maxP0 !== undefined && P0 > maxP0) {
    failures.push(`${P0} P0 findings exceed max ${maxP0}`)
  }
  if (failOnP1 && maxP1 !== undefined && P1 > maxP1) {
    failures.push(`${P1} P1 findings exceed max ${maxP1}`)
  }

  if (failures.length > 0) {
    return {
      mode: 'triage',
      passed: false,
      reason: `Triage gate failed: ${failures.join('; ')}`,
      data,
    }
  }

  return {
    mode: 'triage',
    passed: true,
    reason: 'Triage gate passed',
    data,
  }
}

/**
 * Evaluate quality gates across one or more modes.
 * All modes are AND'd — all must pass for an overall pass result.
 */
export function evaluateGates(
  modes: GateMode[],
  summary: ReportSummary,
  options: GateOptions,
): GateResult {
  const details: GateModeResult[] = []

  for (const mode of modes) {
    if (mode === 'delta') {
      details.push(evaluateDelta(summary, options))
    } else if (mode === 'threshold') {
      details.push(evaluateThreshold(summary, options))
    } else if (mode === 'triage') {
      details.push(evaluateTriage(summary, options))
    } else {
      // Unknown mode: pass with a note
      details.push({
        mode,
        passed: true,
        reason: `Gate mode '${mode}' is not implemented; skipped`,
        data: {},
      })
    }
  }

  const allPassed = details.every((d) => d.passed)
  const summaryLines = details.map((d) => `[${d.mode}] ${d.passed ? 'PASS' : 'FAIL'}: ${d.reason}`)

  return {
    result: allPassed ? 'pass' : 'fail',
    summary: summaryLines.join('\n'),
    details,
  }
}
