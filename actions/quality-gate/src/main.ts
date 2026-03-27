import * as core from '@actions/core'
import { evaluateGates, parseReportDirectory } from '@finite-state/core'
import type { GateMode, GateOptions, ReportSummary } from '@finite-state/core'

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Map user-facing mode strings to GateMode values.
 * 'triage-priority' maps to the internal 'triage' GateMode.
 */
function parseMode(raw: string): GateMode {
  const trimmed = raw.trim().toLowerCase()
  if (trimmed === 'triage-priority') return 'triage'
  return trimmed as GateMode
}

// ── Main ───────────────────────────────────────────────────────────────────────

export async function run(): Promise<void> {
  try {
    // ── Parse modes ──────────────────────────────────────────────────────────
    const modeInput = core.getInput('mode', { required: true })
    const modes: GateMode[] = modeInput
      .split(',')
      .map((m) => parseMode(m))
      .filter(Boolean)

    // ── Load ReportSummary ───────────────────────────────────────────────────
    let summary: ReportSummary

    const summaryJson = core.getInput('summary-json')
    const reportDir = core.getInput('report-dir')

    if (summaryJson) {
      summary = JSON.parse(summaryJson) as ReportSummary
      core.info('Loaded summary from summary-json input')
    } else if (reportDir) {
      summary = parseReportDirectory(reportDir)
      core.info(`Loaded summary from report directory: ${reportDir}`)
    } else {
      throw new Error('Either summary-json or report-dir must be provided')
    }

    // ── Build GateOptions ────────────────────────────────────────────────────
    const options: GateOptions = {}

    // Delta options
    const maxNewCriticalStr = core.getInput('max-new-critical')
    if (maxNewCriticalStr !== '') {
      options.maxNewCritical = parseInt(maxNewCriticalStr, 10)
    }

    const maxNewHighStr = core.getInput('max-new-high')
    if (maxNewHighStr !== '') {
      options.maxNewHigh = parseInt(maxNewHighStr, 10)
    }

    const maxNewMediumStr = core.getInput('max-new-medium')
    if (maxNewMediumStr !== '') {
      options.maxNewMedium = parseInt(maxNewMediumStr, 10)
    }

    // Threshold options
    const maxCriticalStr = core.getInput('max-critical')
    if (maxCriticalStr !== '') {
      options.maxCritical = parseInt(maxCriticalStr, 10)
    }

    const maxHighStr = core.getInput('max-high')
    if (maxHighStr !== '') {
      options.maxHigh = parseInt(maxHighStr, 10)
    }

    const maxTotalStr = core.getInput('max-total')
    if (maxTotalStr !== '') {
      options.maxTotal = parseInt(maxTotalStr, 10)
    }

    // Triage options (booleans — wrap in try/catch for optional inputs)
    try {
      options.failOnP0 = core.getBooleanInput('fail-on-p0')
    } catch {
      // optional — leave undefined
    }

    try {
      options.failOnP1 = core.getBooleanInput('fail-on-p1')
    } catch {
      // optional — leave undefined
    }

    const maxP0Str = core.getInput('max-p0')
    if (maxP0Str !== '') {
      options.maxP0 = parseInt(maxP0Str, 10)
    }

    const maxP1Str = core.getInput('max-p1')
    if (maxP1Str !== '') {
      options.maxP1 = parseInt(maxP1Str, 10)
    }

    // ── Evaluate gates ───────────────────────────────────────────────────────
    const gateResult = evaluateGates(modes, summary, options)

    // ── Set outputs ──────────────────────────────────────────────────────────
    core.setOutput('result', gateResult.result)
    core.setOutput('summary', gateResult.summary)
    core.setOutput('details-json', JSON.stringify(gateResult.details))

    // ── Log details ──────────────────────────────────────────────────────────
    for (const detail of gateResult.details) {
      const icon = detail.passed ? '✅' : '❌'
      core.info(`${icon} [${detail.mode}] ${detail.reason}`)
    }

    // ── Fail the action if the gate failed ───────────────────────────────────
    if (gateResult.result === 'fail') {
      core.setFailed(`Quality gate failed:\n${gateResult.summary}`)
    } else {
      core.info(`Quality gate passed`)
    }
  } catch (err) {
    core.setFailed(err instanceof Error ? err.message : String(err))
  }
}

run()
