import type { ReportSummary, GateResult, TriageFinding } from './models'

const DEFAULT_TAG = 'finite-state'

// ── Helpers ────────────────────────────────────────────────────────────────────

function commentTag(tag: string): string {
  return `<!-- ${tag} -->`
}

function gateSection(gate: GateResult): string {
  const label = gate.result === 'pass' ? '**Quality Gate: PASSED**' : '**Quality Gate: FAILED**'
  return `\n${label}\n\n${gate.summary}\n`
}

function headerWithIcon(title: string, gate?: GateResult): string {
  if (!gate) return `## ${title}`
  const icon = gate.result === 'pass' ? ':white_check_mark:' : ':x:'
  return `## ${title} ${icon}`
}

// ── renderSummaryComment ───────────────────────────────────────────────────────

/**
 * Renders a markdown PR comment summarising findings by severity.
 */
export function renderSummaryComment(
  summary: ReportSummary,
  gate?: GateResult,
  commentTag_: string = DEFAULT_TAG,
): string {
  const { severityCounts, totalFindings } = summary

  const table = [
    '| Severity | Count |',
    '|----------|-------|',
    `| CRITICAL | ${severityCounts.CRITICAL} |`,
    `| HIGH     | ${severityCounts.HIGH} |`,
    `| MEDIUM   | ${severityCounts.MEDIUM} |`,
    `| LOW      | ${severityCounts.LOW} |`,
    `| **Total** | **${totalFindings}** |`,
  ].join('\n')

  const lines: string[] = [
    commentTag(commentTag_),
    '',
    headerWithIcon('Finite State Security Report', gate),
    '',
    table,
  ]

  if (gate) {
    lines.push(gateSection(gate))
  }

  return lines.join('\n')
}

// ── renderTriageComment ────────────────────────────────────────────────────────

/**
 * Renders a markdown PR comment summarising triage priority bands.
 */
export function renderTriageComment(
  summary: ReportSummary,
  gate?: GateResult,
  commentTag_: string = DEFAULT_TAG,
): string {
  const lines: string[] = [
    commentTag(commentTag_),
    '',
    headerWithIcon('Finite State Triage Report', gate),
    '',
  ]

  if (summary.triageBands) {
    const { P0, P1, P2, P3, topFindings } = summary.triageBands

    const table = [
      '| Priority | Count |',
      '|----------|-------|',
      `| P0       | ${P0} |`,
      `| P1       | ${P1} |`,
      `| P2       | ${P2} |`,
      `| P3       | ${P3} |`,
    ].join('\n')

    lines.push(table)
    lines.push('')

    // Top Priority Findings (P0 and P1)
    const priorityFindings = topFindings.filter(
      (f): f is TriageFinding => f !== undefined,
    )

    if (priorityFindings.length > 0) {
      lines.push('### Top Priority Findings')
      lines.push('')
      lines.push('| Finding | Component | Severity | Risk |')
      lines.push('|---------|-----------|----------|------|')
      for (const f of priorityFindings) {
        const title = f.title ? ` — ${f.title}` : ''
        lines.push(`| ${f.findingId}${title} | ${f.component} | ${f.severity} | ${f.risk} |`)
      }
      lines.push('')
    }
  } else {
    lines.push('_No triage data available._')
    lines.push('')
  }

  if (gate) {
    lines.push(gateSection(gate))
  }

  return lines.join('\n')
}

// ── renderComparisonComment ────────────────────────────────────────────────────

/**
 * Renders a markdown PR comment comparing findings between two versions.
 */
export function renderComparisonComment(
  summary: ReportSummary,
  gate?: GateResult,
  commentTag_: string = DEFAULT_TAG,
): string {
  const lines: string[] = [
    commentTag(commentTag_),
    '',
    headerWithIcon('Finite State Version Comparison', gate),
    '',
  ]

  if (summary.versionDelta) {
    const { newFindings, fixedFindings, newBySeverity, fixedBySeverity } = summary.versionDelta

    const table = [
      '| Severity | New | Fixed |',
      '|----------|-----|-------|',
      `| CRITICAL | ${newBySeverity.CRITICAL} | ${fixedBySeverity.CRITICAL} |`,
      `| HIGH     | ${newBySeverity.HIGH} | ${fixedBySeverity.HIGH} |`,
      `| MEDIUM   | ${newBySeverity.MEDIUM} | ${fixedBySeverity.MEDIUM} |`,
      `| LOW      | ${newBySeverity.LOW} | ${fixedBySeverity.LOW} |`,
    ].join('\n')

    lines.push(table)
    lines.push('')

    // New Findings section
    lines.push(`### New Findings (${newFindings.length})`)
    lines.push('')
    if (newFindings.length > 0) {
      lines.push('| Finding | Component | Severity | Risk |')
      lines.push('|---------|-----------|----------|------|')
      for (const f of newFindings) {
        lines.push(`| ${f.findingId} | ${f.component} | ${f.severity} | ${f.risk} |`)
      }
    } else {
      lines.push('_No new findings._')
    }
    lines.push('')

    // Fixed Findings section
    lines.push(`### Fixed Findings (${fixedFindings.length})`)
    lines.push('')
    if (fixedFindings.length > 0) {
      lines.push('| Finding | Component | Severity | Risk |')
      lines.push('|---------|-----------|----------|------|')
      for (const f of fixedFindings) {
        lines.push(`| ${f.findingId} | ${f.component} | ${f.severity} | ${f.risk} |`)
      }
    } else {
      lines.push('_No fixed findings._')
    }
    lines.push('')
  } else {
    lines.push('_No version comparison data available._')
    lines.push('')
  }

  if (gate) {
    lines.push(gateSection(gate))
  }

  return lines.join('\n')
}
