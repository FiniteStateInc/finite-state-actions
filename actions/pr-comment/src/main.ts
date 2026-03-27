import * as core from '@actions/core'
import * as github from '@actions/github'
import {
  parseReportDirectory,
  renderSummaryComment,
  renderTriageComment,
  renderComparisonComment,
} from '@finite-state/core'
import type { ReportSummary, GateResult } from '@finite-state/core'

// ── Main ───────────────────────────────────────────────────────────────────────

export async function run(): Promise<void> {
  try {
    // ── Check for PR context ──────────────────────────────────────────────────
    const ctx = github.context

    if (!ctx.payload.pull_request) {
      core.info('Not a pull request')
      return
    }

    const prNumber = ctx.payload.pull_request.number as number
    const { owner, repo } = ctx.repo

    // ── Load ReportSummary ────────────────────────────────────────────────────
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

    // ── Build GateResult if provided ──────────────────────────────────────────
    let gate: GateResult | undefined

    const gateResultInput = core.getInput('gate-result')
    const gateSummaryInput = core.getInput('gate-summary')

    if (gateResultInput) {
      gate = {
        result: gateResultInput as 'pass' | 'fail',
        summary: gateSummaryInput,
        details: [],
      }
    }

    // ── Select render function by template ────────────────────────────────────
    const template = core.getInput('template') || 'summary'
    const commentTag = core.getInput('comment-tag') || 'finite-state'

    let body: string

    if (template === 'triage') {
      body = renderTriageComment(summary, gate, commentTag)
    } else if (template === 'comparison') {
      body = renderComparisonComment(summary, gate, commentTag)
    } else {
      // 'summary' | 'detailed' | 'custom' — default to renderSummaryComment
      body = renderSummaryComment(summary, gate, commentTag)
    }

    // ── Get GitHub token and create octokit ───────────────────────────────────
    const token = process.env.GITHUB_TOKEN
    if (!token) {
      throw new Error('GITHUB_TOKEN environment variable is not set')
    }

    const octokit = github.getOctokit(token)

    // ── Find existing comment by tag ──────────────────────────────────────────
    const tagMarker = `<!-- ${commentTag} -->`

    const { data: comments } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: prNumber,
    })

    const existing = comments.find((c) => c.body?.includes(tagMarker))

    // ── Create or update the comment ──────────────────────────────────────────
    let commentId: number
    let commentUrl: string

    if (existing) {
      core.info(`Updating existing comment ${existing.id}`)
      const { data } = await octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: existing.id,
        body,
      })
      commentId = data.id
      commentUrl = data.html_url
    } else {
      core.info('Creating new PR comment')
      const { data } = await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body,
      })
      commentId = data.id
      commentUrl = data.html_url
    }

    // ── Set outputs ───────────────────────────────────────────────────────────
    core.setOutput('comment-id', commentId)
    core.setOutput('comment-url', commentUrl)

    core.info(`Comment ${existing ? 'updated' : 'created'}: ${commentUrl}`)
  } catch (err) {
    core.setFailed(err instanceof Error ? err.message : String(err))
  }
}

run()
