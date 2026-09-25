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

const mockExistsSync = vi.fn(() => true)

vi.mock('fs', () => ({
  mkdirSync: vi.fn(),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
}))

// ── Mock @finite-state/core ────────────────────────────────────────────────────

vi.mock('@finite-state/core', async () => {
  // The real validator, imported from source the way the upload action's suite
  // does: format validation is the behaviour under test in the format cases, so
  // a stub would assert nothing and could drift from core.
  const { normalizeSbomFormat } = await import('../../../packages/core/src/sbom-format')
  // quoteExecPath comes from source too: a stubbed quoting rule would assert
  // nothing about the Windows path splitting it exists to prevent.
  const { quoteExecPath } = await import('../../../packages/core/src/exec-path')
  return {
    FsClient: vi.fn().mockImplementation(() => ({})),
    ensureFsCli: vi.fn(async () => '/tmp/fs-cli/fs-cli'),
    quoteExecPath,
    readSetupContext: vi.fn(),
    normalizeSbomFormat,
  }
})

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

    // vi.clearAllMocks() drops the default return value along with the calls.
    mockExistsSync.mockReturnValue(true)
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

  // An exit-0 export that wrote nothing must fail rather than publish
  // component-count: 0, which a downstream gate reads as a clean SBOM.
  it('fails when fs-cli exits 0 but wrote no file', async () => {
    mockExistsSync.mockReturnValue(false)

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('wrote no file'))
    expect(mockUploadArtifact).not.toHaveBeenCalled()
  })

  // A zero-byte file clears existsSync, so without its own check it would land
  // in the parse-warning path and publish component-count: 0 — the same "clean
  // SBOM" false positive the missing-file check closes, one case over.
  it.each([
    ['zero-byte', ''],
    ['whitespace-only', '  \n\t '],
  ])('fails when fs-cli exits 0 but wrote a %s file', async (_label, contents) => {
    mockReadFileSync.mockReturnValue(contents)

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('empty file'))
    expect(mockUploadArtifact).not.toHaveBeenCalled()
    expect(core.setOutput).not.toHaveBeenCalledWith('component-count', '0')
  })

  // Counting must not stop at an empty `components` when `packages` is
  // populated: a merged or wrapped document holds both.
  it('counts packages when components is present but empty', async () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ components: [], packages: [{ name: 'openssl' }, { name: 'zlib' }] }),
    )

    await run()

    expect(core.setOutput).toHaveBeenCalledWith('component-count', '2')
    expect(core.warning).not.toHaveBeenCalled()
  })

  it('accepts the cdx alias and normalises case for format', async () => {
    vi.mocked(core.getInput).mockImplementation((name: string) => {
      const inputs: Record<string, string> = { format: 'CDX', 'output-file': 'sbom.json' }
      return inputs[name] ?? ''
    })

    await run()

    expect(fsCliArgs()).toEqual(expect.arrayContaining(['--format', 'cyclonedx']))
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('fails on an unrecognized format instead of passing it to fs-cli', async () => {
    vi.mocked(core.getInput).mockImplementation((name: string) => {
      const inputs: Record<string, string> = { format: 'spdx-json', 'output-file': 'sbom.json' }
      return inputs[name] ?? ''
    })

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('is not recognized'))
    expect(mockExec).not.toHaveBeenCalled()
  })

  // The REST path this replaced imposed no size limit, so the input is the only
  // way back to that behaviour for a version with a very large SBOM.
  it('passes --max-size only when the input is set', async () => {
    await run()
    expect(fsCliArgs()).not.toContain('--max-size')

    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(true)
    mockExec.mockResolvedValue(0)
    mockReadFileSync.mockReturnValue(JSON.stringify({ components: [] }))
    vi.mocked(readSetupContext).mockReturnValue({
      apiToken: 'test-token',
      domain: 'app.finitestate.io',
      versionId: 'ver-456',
    })
    vi.mocked(core.getInput).mockImplementation((name: string) => {
      const inputs: Record<string, string> = { 'max-size': '256', 'output-file': 'sbom.json' }
      return inputs[name] ?? ''
    })

    await run()

    expect(fsCliArgs()).toEqual(expect.arrayContaining(['--max-size', '256']))
  })

  // An explicit version-id shadows the other locator inputs; saying so is what
  // stops a mistaken version-id from looking like the label applied.
  it('warns that a version-id shadowed the project and version inputs', async () => {
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

    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('project-name, version'),
      expect.objectContaining({ title: 'Locator inputs ignored' }),
    )
  })

  // Names every ignored project input, so an operator does not fix one and
  // leave the other.
  it('names both project inputs when both are dropped for an inherited ID', async () => {
    vi.mocked(core.getInput).mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        'project-id': 'proj-explicit',
        'project-name': 'my-app',
        'output-file': 'sbom.json',
      }
      return inputs[name] ?? ''
    })
    vi.mocked(readSetupContext).mockReturnValue({
      apiToken: 'test-token',
      domain: 'app.finitestate.io',
      projectId: 'proj-explicit',
      projectName: 'my-app',
      versionId: 'ver-456',
    })

    await run()

    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('project-id and project-name'),
      expect.objectContaining({ title: 'Project input ignored' }),
    )
  })

  // The inherited-name branch: FINITE_STATE_PROJECT_NAME with no project UUID,
  // plus an explicit label. Previously only the inherited-ID path was covered.
  it('resolves an inherited project name with an explicit version label', async () => {
    vi.mocked(core.getInput).mockImplementation((name: string) => {
      const inputs: Record<string, string> = { version: '1.2.3', 'output-file': 'sbom.json' }
      return inputs[name] ?? ''
    })
    vi.mocked(readSetupContext).mockReturnValue({
      apiToken: 'test-token',
      domain: 'app.finitestate.io',
      projectId: undefined,
      projectName: 'inherited-app',
      versionId: undefined,
    })

    await run()

    const args = fsCliArgs()
    expect(args).toEqual(expect.arrayContaining(['--name', 'inherited-app', '--version', '1.2.3']))
    expect(args).not.toContain('--project-id')
  })

  it('passes both project inputs into readSetupContext', async () => {
    vi.mocked(core.getInput).mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        'project-id': 'proj-explicit',
        'project-name': 'my-app',
        version: '1.2.3',
        'output-file': 'sbom.json',
      }
      return inputs[name] ?? ''
    })

    await run()

    expect(readSetupContext).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'proj-explicit', projectName: 'my-app' }),
    )
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
