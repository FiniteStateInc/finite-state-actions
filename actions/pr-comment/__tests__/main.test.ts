import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock @actions/core ─────────────────────────────────────────────────────────

vi.mock('@actions/core', () => ({
  getInput: vi.fn(),
  getBooleanInput: vi.fn(),
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}))

// ── Mock @actions/github ───────────────────────────────────────────────────────

const mockCreateComment = vi.fn()
const mockUpdateComment = vi.fn()
const mockListComments = vi.fn()

vi.mock('@actions/github', () => ({
  context: {
    eventName: 'pull_request',
    payload: {
      pull_request: {
        number: 42,
      },
    },
    repo: {
      owner: 'test-owner',
      repo: 'test-repo',
    },
  },
  getOctokit: vi.fn(() => ({
    rest: {
      issues: {
        createComment: mockCreateComment,
        updateComment: mockUpdateComment,
        listComments: mockListComments,
      },
    },
  })),
}))

// ── Mock @finite-state/core ────────────────────────────────────────────────────

vi.mock('@finite-state/core', () => ({
  parseReportDirectory: vi.fn(),
  renderSummaryComment: vi.fn(() => '<!-- finite-state -->\n## Finite State Security Report'),
  renderTriageComment: vi.fn(() => '<!-- finite-state -->\n## Finite State Triage Report'),
  renderComparisonComment: vi.fn(() => '<!-- finite-state -->\n## Finite State Version Comparison'),
}))

// ── Imports (after mocks) ──────────────────────────────────────────────────────

import * as core from '@actions/core'
import { run } from '../src/main'

// ── Shared test fixtures ───────────────────────────────────────────────────────

const baseSummary = {
  severityCounts: { CRITICAL: 2, HIGH: 5, MEDIUM: 10, LOW: 3, NONE: 0 },
  totalFindings: 20,
}

const baseInputs: Record<string, string> = {
  'summary-json': JSON.stringify(baseSummary),
  'report-dir': '',
  template: 'summary',
  'custom-template': '',
  'gate-result': '',
  'gate-summary': '',
  'comment-tag': 'finite-state',
  'collapse-details': 'true',
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('pr-comment action', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    vi.mocked(core.getInput).mockImplementation((name: string) => baseInputs[name] ?? '')

    process.env.GITHUB_TOKEN = 'test-token'
  })

  it('creates a new comment when none exists', async () => {
    mockListComments.mockResolvedValue({
      data: [{ id: 1, body: 'some other comment', html_url: 'https://github.com/comment/1' }],
    })

    mockCreateComment.mockResolvedValue({
      data: { id: 99, html_url: 'https://github.com/comment/99' },
    })

    await run()

    expect(mockCreateComment).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'test-owner',
        repo: 'test-repo',
        issue_number: 42,
        body: expect.any(String),
      }),
    )
    expect(mockUpdateComment).not.toHaveBeenCalled()
    expect(core.setOutput).toHaveBeenCalledWith('comment-id', 99)
    expect(core.setOutput).toHaveBeenCalledWith('comment-url', 'https://github.com/comment/99')
  })

  it('updates existing comment by tag', async () => {
    mockListComments.mockResolvedValue({
      data: [
        {
          id: 55,
          body: '<!-- finite-state -->\n## Old Report',
          html_url: 'https://github.com/comment/55',
        },
      ],
    })

    mockUpdateComment.mockResolvedValue({
      data: { id: 55, html_url: 'https://github.com/comment/55' },
    })

    await run()

    expect(mockUpdateComment).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'test-owner',
        repo: 'test-repo',
        comment_id: 55,
        body: expect.any(String),
      }),
    )
    expect(mockCreateComment).not.toHaveBeenCalled()
    expect(core.setOutput).toHaveBeenCalledWith('comment-id', 55)
    expect(core.setOutput).toHaveBeenCalledWith('comment-url', 'https://github.com/comment/55')
  })

  it('skips when not a pull request', async () => {
    // Override github.context to simulate a push event (no pull_request in payload)
    const githubModule = await import('@actions/github')
    vi.spyOn(githubModule, 'context', 'get').mockReturnValue({
      eventName: 'push',
      payload: {},
      repo: { owner: 'test-owner', repo: 'test-repo' },
    } as typeof githubModule.context)

    await run()

    expect(core.info).toHaveBeenCalledWith('Not a pull request')
    expect(mockCreateComment).not.toHaveBeenCalled()
    expect(mockUpdateComment).not.toHaveBeenCalled()
  })
})
