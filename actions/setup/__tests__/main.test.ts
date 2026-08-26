import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock @actions/core ─────────────────────────────────────────────────────────

vi.mock('@actions/core', () => ({
  getInput: vi.fn(),
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  setSecret: vi.fn(),
  exportVariable: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}))

// ── Mock @finite-state/core ────────────────────────────────────────────────────

const mockGetAuthUser = vi.fn()
const mockResolveProjectId = vi.fn()
const mockInstallFsCli = vi.fn()

vi.mock('@finite-state/core', () => {
  // Declared inside the factory: vi.mock is hoisted above module scope.
  class ProjectNotFoundError extends Error {
    constructor(public readonly projectName: string) {
      super(`No project found with name "${projectName}".`)
      this.name = 'ProjectNotFoundError'
    }
  }

  return {
    FsClient: vi.fn().mockImplementation(() => ({
      getAuthUser: mockGetAuthUser,
    })),
    ProjectNotFoundError,
    authUserIdentity: (u: Record<string, unknown>) => u?.user ?? u?.email ?? undefined,
    authUserOrganization: (u: { organization?: { name?: string; id?: string } }) =>
      u?.organization?.name ?? u?.organization?.id ?? undefined,
    installFsCli: (...args: unknown[]) => mockInstallFsCli(...args),
    writeSetupContext: vi.fn(),
    resolveProjectId: (...args: unknown[]) => mockResolveProjectId(...args),
  }
})

// ── Imports (after mocks) ──────────────────────────────────────────────────────

import * as core from '@actions/core'
import { FsClient, ProjectNotFoundError, writeSetupContext } from '@finite-state/core'
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
        'project-name': '',
        'version-id': 'ver-456',
      }
      return inputs[name] ?? ''
    })

    mockGetAuthUser.mockResolvedValue({
      user: 'testuser@example.com',
      organization: { id: 'org-1', name: 'Test Org' },
    })

    mockResolveProjectId.mockImplementation((_client: unknown, value: string) =>
      Promise.resolve(value),
    )

    mockInstallFsCli.mockResolvedValue('/tmp/fs-cli/fs-cli')
  })

  it('validates auth and exports context with project-id', async () => {
    await run()

    expect(FsClient).toHaveBeenCalledWith({
      apiToken: 'test-token',
      domain: 'app.finitestate.io',
    })
    expect(mockGetAuthUser).toHaveBeenCalled()
    expect(mockResolveProjectId).not.toHaveBeenCalled()

    expect(writeSetupContext).toHaveBeenCalledWith({
      apiToken: 'test-token',
      domain: 'app.finitestate.io',
      projectId: 'proj-123',
      versionId: 'ver-456',
    })

    expect(core.setOutput).toHaveBeenCalledWith('user', 'testuser@example.com')
    expect(core.setOutput).toHaveBeenCalledWith('org-name', 'Test Org')
    expect(core.setOutput).toHaveBeenCalledWith('project-id', 'proj-123')
    expect(core.setOutput).toHaveBeenCalledWith('version-id', 'ver-456')
    expect(mockInstallFsCli).toHaveBeenCalledOnce()
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('fails the action when fs-cli installation fails', async () => {
    mockInstallFsCli.mockRejectedValue(new Error('Failed to download fs-cli: HTTP 403'))

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('Failed to download fs-cli'),
    )
  })

  it('resolves project-name to ID', async () => {
    vi.mocked(core.getInput).mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        'api-token': 'test-token',
        domain: 'app.finitestate.io',
        'project-id': '',
        'project-name': 'WebGoat',
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

  it('fails when both project-id and project-name are provided', async () => {
    vi.mocked(core.getInput).mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        'api-token': 'test-token',
        domain: 'app.finitestate.io',
        'project-id': 'proj-123',
        'project-name': 'WebGoat',
        'version-id': '',
      }
      return inputs[name] ?? ''
    })

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('either project-id or project-name'),
    )
  })

  it('fails with clear error on invalid auth (401)', async () => {
    mockGetAuthUser.mockRejectedValue(
      new Error('Unauthorized (401): Invalid or missing API token.'),
    )

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('Unauthorized (401)'))
  })

  it('warns and continues when the project name does not exist yet', async () => {
    vi.mocked(core.getInput).mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        'api-token': 'test-token',
        domain: 'app.finitestate.io',
        'project-id': '',
        'project-name': 'WebGoat',
        'version-id': '',
      }
      return inputs[name] ?? ''
    })

    mockResolveProjectId.mockRejectedValue(new ProjectNotFoundError('WebGoat'))

    await run()

    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('No existing project'))
    expect(core.setFailed).not.toHaveBeenCalled()
    expect(writeSetupContext).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: undefined, projectName: 'WebGoat' }),
    )
    expect(core.setOutput).not.toHaveBeenCalledWith('project-id', expect.anything())
  })

  it('still fails when the project name is ambiguous', async () => {
    vi.mocked(core.getInput).mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        'api-token': 'test-token',
        domain: 'app.finitestate.io',
        'project-id': '',
        'project-name': 'WebGoat',
        'version-id': '',
      }
      return inputs[name] ?? ''
    })

    mockResolveProjectId.mockRejectedValue(new Error('Multiple projects match name "WebGoat"'))

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('Multiple projects match'))
    expect(core.warning).not.toHaveBeenCalled()
  })

  it('warns when /authUser returns an unrecognized shape', async () => {
    mockGetAuthUser.mockResolvedValue({ somethingElse: true })

    await run()

    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('unrecognized /authUser'))
    expect(core.setFailed).not.toHaveBeenCalled()
  })
})
