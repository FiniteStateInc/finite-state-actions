import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock @actions/core ─────────────────────────────────────────────────────────

vi.mock('@actions/core', () => ({
  getInput: vi.fn(),
  getBooleanInput: vi.fn(),
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  setSecret: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}))

// ── Mock @actions/exec ─────────────────────────────────────────────────────────

const mockExec = vi.fn()

vi.mock('@actions/exec', () => ({
  exec: (...args: unknown[]) => mockExec(...args),
}))

// ── Mock @actions/artifact ─────────────────────────────────────────────────────

const mockUploadArtifact = vi.fn()

vi.mock('@actions/artifact', () => ({
  DefaultArtifactClient: vi.fn().mockImplementation(() => ({
    uploadArtifact: mockUploadArtifact,
  })),
}))

// ── Mock fs ────────────────────────────────────────────────────────────────────

const mockReadFileSync = vi.fn()

vi.mock('fs', () => ({
  mkdirSync: vi.fn(),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
}))

// ── Mock @finite-state/core ────────────────────────────────────────────────────

vi.mock('@finite-state/core', () => ({
  FsClient: vi.fn().mockImplementation(() => ({})),
  ensureFsCli: vi.fn(async () => '/tmp/fs-cli/fs-cli'),
  quoteExecPath: (p: string) => `"${p}"`,
  readSetupContext: vi.fn(),
}))

// ── Imports (after mocks) ──────────────────────────────────────────────────────

import * as core from '@actions/core'
import { readSetupContext } from '@finite-state/core'
import { run } from '../src/main'

/** The argument list passed to the one fs-cli invocation. */
function fsCliArgs(): string[] {
  return mockExec.mock.calls[0][1] as string[]
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('download-sbom action', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    vi.mocked(readSetupContext).mockReturnValue({
      apiToken: 'test-token',
      domain: 'app.finitestate.io',
      projectId: 'proj-123',
      versionId: 'ver-456',
    })

    vi.mocked(core.getInput).mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        'version-id': '',
        format: 'cyclonedx',
        'include-vex': 'true',
        'output-file': 'sbom.json',
        'upload-artifact': 'true',
        'artifact-name': 'finite-state-sbom',
      }
      return inputs[name] ?? ''
    })

    vi.mocked(core.getBooleanInput).mockImplementation((name: string) => {
      if (name === 'include-vex') return true
      if (name === 'upload-artifact') return true
      return false
    })

    mockExec.mockResolvedValue(0)

    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        bomFormat: 'CycloneDX',
        components: [
          { name: 'openssl', version: '1.1.1' },
          { name: 'zlib', version: '1.2.11' },
          { name: 'libpng', version: '1.6.37' },
        ],
      }),
    )

    mockUploadArtifact.mockResolvedValue({ artifactId: 99, size: 2048 })
  })

  it('exports a CycloneDX SBOM via fs-cli and uploads the artifact', async () => {
    await run()

    const [command, args, options] = mockExec.mock.calls[0]

    // The binary path is quoted, because exec splits its first parameter.
    expect(command).toBe('"/tmp/fs-cli/fs-cli"')
    expect(args).toEqual([
      'export',
      '--endpoint',
      'https://app.finitestate.io',
      '--version-id',
      'ver-456',
      '--format',
      'cyclonedx',
      '--include-vex=true',
      '--output-file',
      'sbom.json',
      '--overwrite',
    ])

    // The token never reaches the argument list.
    expect(args).not.toContain('--token')
    expect((options.env as Record<string, string>).FS_TOKEN).toBe('test-token')

    expect(core.setOutput).toHaveBeenCalledWith('file', 'sbom.json')
    expect(core.setOutput).toHaveBeenCalledWith('component-count', '3')
    expect(core.setOutput).toHaveBeenCalledWith('artifact-name', 'finite-state-sbom')

    expect(mockUploadArtifact).toHaveBeenCalledWith(
      'finite-state-sbom',
      ['sbom.json'],
      expect.any(String),
    )

    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('passes include-vex=false through to fs-cli', async () => {
    vi.mocked(core.getBooleanInput).mockImplementation((name: string) => name === 'upload-artifact')

    await run()

    expect(fsCliArgs()).toContain('--include-vex=false')
  })

  it('counts SPDX packages, not just CycloneDX components', async () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        spdxVersion: 'SPDX-2.3',
        packages: [{ name: 'openssl' }, { name: 'zlib' }],
      }),
    )

    await run()

    expect(core.setOutput).toHaveBeenCalledWith('component-count', '2')
  })

  it('warns instead of failing when the written SBOM cannot be parsed', async () => {
    mockReadFileSync.mockReturnValue('not json')

    await run()

    expect(core.warning).toHaveBeenCalled()
    expect(core.setOutput).toHaveBeenCalledWith('component-count', '0')
    expect(mockUploadArtifact).toHaveBeenCalled()
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  // A shape this action does not model must not be indistinguishable from an
  // SBOM that genuinely has no components: `component-count` is what downstream
  // gates read, so a silent 0 there reads as a clean result.
  it('warns when the SBOM parses but carries neither components nor packages', async () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ spdxVersion: 'SPDX-3.0', elements: [] }))

    await run()

    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('neither'),
      expect.objectContaining({ title: 'Component count unavailable' }),
    )
    expect(core.setOutput).toHaveBeenCalledWith('component-count', '0')
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  // An empty SBOM is a legitimate 0 and must stay quiet, or the warning above
  // would fire on every components-only export of a version with no packages.
  it('reports 0 without warning for an SBOM with an empty components array', async () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ bomFormat: 'CycloneDX', components: [] }))

    await run()

    expect(core.setOutput).toHaveBeenCalledWith('component-count', '0')
    expect(core.warning).not.toHaveBeenCalled()
  })

  it('resolves by project-name and version when no version ID is known', async () => {
    vi.mocked(core.getInput).mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        'project-name': 'my-app',
        version: '1.2.3',
        format: 'spdx',
        'output-file': 'sbom.json',
        'artifact-name': 'finite-state-sbom',
      }
      return inputs[name] ?? ''
    })
    vi.mocked(readSetupContext).mockReturnValue({
      apiToken: 'test-token',
      domain: 'app.finitestate.io',
      projectName: 'my-app',
      versionId: undefined,
    })

    await run()

    const args = fsCliArgs()
    expect(args).toEqual(expect.arrayContaining(['--name', 'my-app', '--version', '1.2.3']))
    expect(args).not.toContain('--version-id')
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  // Typing a version label is an instruction to export that version, not the
  // one an upstream scan happened to leave in FINITE_STATE_VERSION_ID. Without
  // this precedence the label is silently ignored and the wrong SBOM ships.
  it('prefers an explicit version label over an inherited version ID', async () => {
    vi.mocked(core.getInput).mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        'project-name': 'my-app',
        version: '1.2.3',
        'output-file': 'sbom.json',
      }
      return inputs[name] ?? ''
    })
    vi.mocked(readSetupContext).mockReturnValue({
      apiToken: 'test-token',
      domain: 'app.finitestate.io',
      projectId: 'proj-123',
      versionId: 'ver-456',
    })

    await run()

    const args = fsCliArgs()
    expect(args).toEqual(expect.arrayContaining(['--name', 'my-app', '--version', '1.2.3']))
    expect(args).not.toContain('--version-id')
    expect(args).not.toContain('ver-456')
  })

  // The --project-id branch used to be reachable only from inherited env, so a
  // setup-less job that knew its project UUID had no way to pass it.
  it('accepts an explicit project-id and prefers it over project-name', async () => {
    vi.mocked(core.getInput).mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        'project-id': 'proj-explicit',
        'project-name': 'other-app',
        version: '1.2.3',
        'output-file': 'sbom.json',
      }
      return inputs[name] ?? ''
    })
    vi.mocked(readSetupContext).mockReturnValue({
      apiToken: 'test-token',
      domain: 'app.finitestate.io',
      versionId: undefined,
    })

    await run()

    const args = fsCliArgs()
    expect(args).toEqual(expect.arrayContaining(['--project-id', 'proj-explicit']))
    expect(args).not.toContain('--name')
  })

  // A project input cannot locate a version by itself. Falling back to the
  // inherited ID is reasonable, but that ID may belong to another project, so
  // dropping the input silently is not.
  it('warns when a project input is dropped in favour of an inherited version ID', async () => {
    vi.mocked(core.getInput).mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        'project-name': 'my-app',
        'output-file': 'sbom.json',
      }
      return inputs[name] ?? ''
    })
    vi.mocked(readSetupContext).mockReturnValue({
      apiToken: 'test-token',
      domain: 'app.finitestate.io',
      projectName: 'my-app',
      versionId: 'ver-456',
    })

    await run()

    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('without version'),
      expect.objectContaining({ title: 'Project input ignored' }),
    )
    expect(fsCliArgs()).toEqual(expect.arrayContaining(['--version-id', 'ver-456']))
  })

  // The label must not fall through to the inherited ID when no project can be
  // built for it: that would export the upstream scan's version while the
  // workflow asked for a label, which is the override this precedence prevents.
  it('fails rather than using an inherited version ID when a version label has no project', async () => {
    vi.mocked(core.getInput).mockImplementation((name: string) => {
      const inputs: Record<string, string> = { version: '1.2.3', 'output-file': 'sbom.json' }
      return inputs[name] ?? ''
    })
    vi.mocked(readSetupContext).mockReturnValue({
      apiToken: 'test-token',
      domain: 'app.finitestate.io',
      versionId: 'ver-456',
    })

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('needs a project'))
    expect(mockExec).not.toHaveBeenCalled()
  })

  // The explicit version-id input stays the most specific locator of all.
  it('prefers an explicit version-id input over a version label', async () => {
    vi.mocked(core.getInput).mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        'version-id': 'ver-explicit',
        'project-name': 'my-app',
        version: '1.2.3',
        'output-file': 'sbom.json',
      }
      return inputs[name] ?? ''
    })
    vi.mocked(readSetupContext).mockReturnValue({
      apiToken: 'test-token',
      domain: 'app.finitestate.io',
      versionId: 'ver-explicit',
    })

    await run()

    const args = fsCliArgs()
    expect(args).toEqual(expect.arrayContaining(['--version-id', 'ver-explicit']))
    expect(args).not.toContain('--version')
  })

  // With neither input the inherited ID still applies — this is what makes
  // `scan` → `download-sbom` work with no inputs at all.
  it('uses the inherited version ID when neither version input is given', async () => {
    vi.mocked(core.getInput).mockImplementation((name: string) => {
      const inputs: Record<string, string> = { 'output-file': 'sbom.json' }
      return inputs[name] ?? ''
    })
    vi.mocked(readSetupContext).mockReturnValue({
      apiToken: 'test-token',
      domain: 'app.finitestate.io',
      projectId: 'proj-123',
      versionId: 'ver-456',
    })

    await run()

    expect(fsCliArgs()).toEqual(expect.arrayContaining(['--version-id', 'ver-456']))
  })

  it('prefers an explicit project-name over an inherited project ID', async () => {
    vi.mocked(core.getInput).mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        'project-name': 'other-app',
        version: '1.2.3',
        format: 'cyclonedx',
        'output-file': 'sbom.json',
      }
      return inputs[name] ?? ''
    })
    vi.mocked(readSetupContext).mockReturnValue({
      apiToken: 'test-token',
      domain: 'app.finitestate.io',
      projectId: 'proj-123',
      projectName: 'other-app',
      versionId: undefined,
    })

    await run()

    const args = fsCliArgs()
    expect(args).toEqual(expect.arrayContaining(['--name', 'other-app']))
    expect(args).not.toContain('--project-id')
  })

  it('falls back to the inherited project ID when only version is given', async () => {
    vi.mocked(core.getInput).mockImplementation((name: string) => {
      const inputs: Record<string, string> = { version: '1.2.3', 'output-file': 'sbom.json' }
      return inputs[name] ?? ''
    })
    vi.mocked(readSetupContext).mockReturnValue({
      apiToken: 'test-token',
      domain: 'app.finitestate.io',
      projectId: 'proj-123',
      versionId: undefined,
    })

    await run()

    expect(fsCliArgs()).toEqual(expect.arrayContaining(['--project-id', 'proj-123']))
  })

  it('fails when neither a version ID nor a name/version pair is available', async () => {
    vi.mocked(readSetupContext).mockReturnValue({
      apiToken: 'test-token',
      domain: 'app.finitestate.io',
      versionId: undefined,
    })

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('version-id'))
    expect(mockExec).not.toHaveBeenCalled()
  })

  it('fails when fs-cli exits non-zero', async () => {
    mockExec.mockResolvedValue(101)

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('101'))
    expect(mockUploadArtifact).not.toHaveBeenCalled()
  })

  it('passes its own api-token and domain to readSetupContext', async () => {
    vi.mocked(core.getInput).mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        'api-token': 'input-token',
        domain: 'acme.finitestate.io',
        'version-id': 'ver-789',
        format: 'cyclonedx',
        'output-file': 'sbom.json',
        'artifact-name': 'finite-state-sbom',
      }
      return inputs[name] ?? ''
    })
    vi.mocked(readSetupContext).mockReturnValue({
      apiToken: 'input-token',
      domain: 'acme.finitestate.io',
      versionId: 'ver-789',
    })

    await run()

    expect(readSetupContext).toHaveBeenCalledWith({
      apiToken: 'input-token',
      domain: 'acme.finitestate.io',
      projectName: undefined,
      versionId: 'ver-789',
    })
    expect(core.setSecret).toHaveBeenCalledWith('input-token')
    expect(fsCliArgs()).toEqual(expect.arrayContaining(['--version-id', 'ver-789']))
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('leaves token and domain undefined when no input is given', async () => {
    await run()

    expect(readSetupContext).toHaveBeenCalledWith({
      apiToken: undefined,
      domain: undefined,
      projectName: undefined,
      versionId: undefined,
    })
  })
})
