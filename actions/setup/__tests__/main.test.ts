import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock @actions/core ─────────────────────────────────────────────────────────

vi.mock('@actions/core', () => ({
  getInput: vi.fn(),
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  setSecret: vi.fn(),
  exportVariable: vi.fn(),
  info: vi.fn(),
}))

// ── Mock @finite-state/core ────────────────────────────────────────────────────

const mockGetAuthUser = vi.fn()
const mockResolveProjectId = vi.fn()

vi.mock('@finite-state/core', () => ({
  FsClient: vi.fn().mockImplementation(() => ({
    getAuthUser: mockGetAuthUser,
  })),
  writeSetupContext: vi.fn(),
  resolveProjectId: (...args: unknown[]) => mockResolveProjectId(...args),
}))

// ── Imports (after mocks) ──────────────────────────────────────────────────────

import * as core from '@actions/core'
import { FsClient, writeSetupContext, resolveProjectId } from '@finite-state/core'
import { run } from '../src/main'

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('setup action', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    vi.mocked(core.getInput).mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        'api-token': 'test-token',
        domain: 'app.finitestate.io',
        'project-id': 'proj-123',
        'version-id': 'ver-456',
      }
      return inputs[name] ?? ''
    })

    // Default: resolveProjectId returns the value as-is
    mockResolveProjectId.mockImplementation((_client: unknown, value: string) =>
      Promise.resolve(value),
    )
  })

  it('validates auth and exports context', async () => {
    mockGetAuthUser.mockResolvedValue({
      id: 'user-1',
      email: 'testuser@example.com',
      organizationId: 'org-1',
    })

    await run()

    // FsClient was constructed with correct config
    expect(FsClient).toHaveBeenCalledWith({
      apiToken: 'test-token',
      domain: 'app.finitestate.io',
    })

    // getAuthUser was called
    expect(mockGetAuthUser).toHaveBeenCalled()

    // resolveProjectId was called with the input value
    expect(mockResolveProjectId).toHaveBeenCalledWith(expect.anything(), 'proj-123')

    // writeSetupContext was called
    expect(writeSetupContext).toHaveBeenCalledWith({
      apiToken: 'test-token',
      domain: 'app.finitestate.io',
      projectId: 'proj-123',
      versionId: 'ver-456',
    })

    // outputs were set
    expect(core.setOutput).toHaveBeenCalledWith('user', 'testuser@example.com')
    expect(core.setOutput).toHaveBeenCalledWith('org-name', 'org-1')
    expect(core.setOutput).toHaveBeenCalledWith('project-id', 'proj-123')
    expect(core.setOutput).toHaveBeenCalledWith('version-id', 'ver-456')

    // no failure
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('resolves project name to ID', async () => {
    mockGetAuthUser.mockResolvedValue({
      id: 'user-1',
      email: 'testuser@example.com',
      organizationId: 'org-1',
    })

    vi.mocked(core.getInput).mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        'api-token': 'test-token',
        domain: 'app.finitestate.io',
        'project-id': 'WebGoat',
        'version-id': '',
      }
      return inputs[name] ?? ''
    })

    mockResolveProjectId.mockResolvedValue('resolved-uuid-1234')

    await run()

    expect(mockResolveProjectId).toHaveBeenCalledWith(expect.anything(), 'WebGoat')
    expect(writeSetupContext).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'resolved-uuid-1234' }),
    )
    expect(core.setOutput).toHaveBeenCalledWith('project-id', 'resolved-uuid-1234')
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('fails with clear error on invalid auth (401)', async () => {
    mockGetAuthUser.mockRejectedValue(
      new Error('Unauthorized (401): Invalid or missing API token.'),
    )

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('Unauthorized (401)'),
    )
  })
})
