import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Mock @actions/exec ─────────────────────────────────────────────────────────

/** Queued fs-cli results, consumed one per exec call. */
interface FakeRun {
  exitCode: number
  stdout: string
}

const execCalls: { binary: string; args: string[]; options: Record<string, unknown> }[] = []
const runQueue: FakeRun[] = []
let defaultRun: FakeRun = { exitCode: 0, stdout: '' }

const mockExec = vi.fn(
  async (binary: string, args: string[], options: Record<string, unknown> = {}) => {
    execCalls.push({ binary, args, options })
    const run = runQueue.shift() ?? defaultRun
    const listeners = options.listeners as { stdout?: (data: Buffer) => void } | undefined
    if (run.stdout) {
      listeners?.stdout?.(Buffer.from(run.stdout))
    }
    return run.exitCode
  },
)

vi.mock('@actions/exec', () => ({
  exec: (...args: unknown[]) => mockExec(...(args as [string, string[], Record<string, unknown>])),
}))

// ── Mock @actions/core ─────────────────────────────────────────────────────────

vi.mock('@actions/core', () => ({
  getInput: vi.fn(),
  warning: vi.fn(),
  getBooleanInput: vi.fn(),
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  setSecret: vi.fn(),
  exportVariable: vi.fn(),
  info: vi.fn(),
}))

// ── Mock fs ────────────────────────────────────────────────────────────────────

const mockGlobMatches: string[] = []

vi.mock('fs/promises', () => ({
  glob: () =>
    (async function* () {
      for (const match of mockGlobMatches) yield match
    })(),
}))

// ── Mock @finite-state/core ────────────────────────────────────────────────────

const mockEnsureFsCli = vi.fn()

vi.mock('@finite-state/core', () => ({
  FsClient: vi.fn().mockImplementation(() => ({})),
  ensureFsCli: (...args: unknown[]) => mockEnsureFsCli(...args),
  readSetupContext: vi.fn(),
}))

// ── Imports (after mocks) ──────────────────────────────────────────────────────

import * as core from '@actions/core'
import { readSetupContext } from '@finite-state/core'
import { run } from '../src/main'

// ── Helpers ────────────────────────────────────────────────────────────────────

const UPLOAD_LINE = 'upload complete: project=proj-1 version=ver-999\n'

function scanJson(counts: { total: number; completed: number; failed: number }): string {
  return JSON.stringify({
    projectVersionId: 'ver-999',
    found: counts.total > 0,
    tests: {
      totalTests: counts.total,
      completedTests: counts.completed,
      failedTests: counts.failed,
      testTypes: [{ id: 'SCA', name: 'SCA', status: 'COMPLETED' }],
    },
  })
}

function setInputs(inputs: Record<string, string>): void {
  vi.mocked(core.getInput).mockImplementation((name: string) => inputs[name] ?? '')
  vi.mocked(core.getBooleanInput).mockImplementation(
    (name: string) => (inputs[name] ?? '') === 'true',
  )
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('upload action', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    execCalls.length = 0
    runQueue.length = 0
    mockGlobMatches.length = 0
    defaultRun = { exitCode: 0, stdout: '' }

    vi.mocked(readSetupContext).mockReturnValue({
      apiToken: 'test-token',
      domain: 'app.finitestate.io',
      projectId: '42',
      versionId: undefined,
    })

    setInputs({
      type: 'sca',
      file: '/tmp/results.json',
      version: 'v1.2.3',
    })

    mockEnsureFsCli.mockResolvedValue('/usr/local/bin/fs-cli')

    // Present on every GitHub runner; fs-cli requires --name, and this is the
    // fallback when no project name was given.
    process.env.GITHUB_REPOSITORY = 'FiniteStateInc/finite-state-actions'
  })

  afterEach(() => {
    delete process.env.GITHUB_REPOSITORY
  })

  it('uploads through fs-cli and reports the version it created', async () => {
    runQueue.push({ exitCode: 0, stdout: UPLOAD_LINE })

    await run()

    const upload = execCalls[0]
    expect(upload.binary).toBe('/usr/local/bin/fs-cli')
    expect(upload.args.slice(0, 2)).toEqual(['upload', '/tmp/results.json'])
    expect(upload.args).toEqual(
      expect.arrayContaining([
        '--endpoint',
        'https://app.finitestate.io',
        '--project-id',
        '42',
        '--version',
        'v1.2.3',
        '--type',
        'sca',
      ]),
    )
    // no timeout input: fs-cli keeps its own default
    expect(upload.args).not.toContain('--timeout')
    // waiting is opt-in, so the upload is the only call
    expect(execCalls).toHaveLength(1)

    // the token travels by env, never in argv
    expect(upload.args).not.toContain('--token')
    expect((upload.options.env as Record<string, string>).FS_TOKEN).toBe('test-token')

    // version ID comes from fs-cli stdout, not an API call
    expect(core.setOutput).toHaveBeenCalledWith('version-id', 'ver-999')
    expect(core.exportVariable).toHaveBeenCalledWith('FINITE_STATE_VERSION_ID', 'ver-999')
    expect(core.setOutput).toHaveBeenCalledWith('scan-status', 'SUBMITTED')
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('polls scan status with fs-cli query when wait-for-completion is opted into', async () => {
    setInputs({
      type: 'sca',
      file: '/tmp/results.json',
      version: 'v1.2.3',
      'wait-for-completion': 'true',
    })
    runQueue.push(
      { exitCode: 0, stdout: UPLOAD_LINE },
      { exitCode: 0, stdout: scanJson({ total: 2, completed: 2, failed: 0 }) },
    )

    await run()

    const query = execCalls[1]
    expect(query.args).toEqual([
      'query',
      '--type',
      'scan',
      '--format',
      'json',
      '--endpoint',
      'https://app.finitestate.io',
      '--version-id',
      'ver-999',
      '--wait',
      '--fail-on-scan-incomplete',
    ])
    expect(core.setOutput).toHaveBeenCalledWith('scan-status', 'COMPLETED')
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('bounds both phases when timeout is given', async () => {
    setInputs({
      type: 'sca',
      file: '/tmp/results.json',
      version: 'v1.2.3',
      'wait-for-completion': 'true',
      timeout: '600',
    })
    runQueue.push(
      { exitCode: 0, stdout: UPLOAD_LINE },
      { exitCode: 0, stdout: scanJson({ total: 1, completed: 1, failed: 0 }) },
    )

    await run()

    expect(execCalls[0].args).toEqual(expect.arrayContaining(['--timeout', '10']))
    expect(execCalls[1].args).toEqual(expect.arrayContaining(['--poll-timeout', '10']))
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it.each(['ten minutes', '600s', '10 minutes', '-5'])(
    'rejects the malformed timeout %j',
    async (timeout) => {
      setInputs({
        type: 'sca',
        file: '/tmp/results.json',
        version: 'v1.2.3',
        timeout,
      })

      await run()

      expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('timeout must be a'))
      expect(execCalls).toHaveLength(0)
    },
  )

  it.each([
    ['30', '1'],
    ['90', '2'],
  ])('warns that timeout %ss rounds up to %s minute(s)', async (timeout, minutes) => {
    setInputs({
      type: 'sca',
      file: '/tmp/results.json',
      version: 'v1.2.3',
      timeout,
    })
    runQueue.push({ exitCode: 0, stdout: UPLOAD_LINE })

    await run()

    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('rounding up'))
    expect(execCalls[0].args).toEqual(expect.arrayContaining(['--timeout', minutes]))
  })

  it('does not warn when timeout is a whole number of minutes', async () => {
    setInputs({
      type: 'sca',
      file: '/tmp/results.json',
      version: 'v1.2.3',
      timeout: '600',
    })
    runQueue.push({ exitCode: 0, stdout: UPLOAD_LINE })

    await run()

    expect(core.warning).not.toHaveBeenCalled()
  })

  it('rejects an empty type list', async () => {
    setInputs({
      type: ' , ',
      file: '/tmp/results.json',
      version: 'v1.2.3',
    })

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('type is empty'))
    expect(execCalls).toHaveLength(0)
  })

  it('rejects an unrecognized sbom-format', async () => {
    setInputs({
      type: 'sbom',
      'sbom-format': 'swid',
      file: 'sbom.json',
      version: 'v1.2.3',
    })

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('is not recognized'))
    expect(execCalls).toHaveLength(0)
  })

  it('lets fs-cli detect the SBOM format when sbom-format is unset', async () => {
    setInputs({
      type: 'sbom',
      file: 'sbom.json',
      version: 'v1.2.3',
    })
    runQueue.push({ exitCode: 0, stdout: 'Imported SBOM: project=proj-1 version=ver-999\n' })

    await run()

    expect(execCalls[0].args).not.toContain('--format')
  })

  it('reports COMPLETED from the exit code when query output is unparseable', async () => {
    setInputs({
      type: 'sca',
      file: '/tmp/results.json',
      version: 'v1.2.3',
      'wait-for-completion': 'true',
    })
    runQueue.push({ exitCode: 0, stdout: UPLOAD_LINE }, { exitCode: 0, stdout: 'no json here' })

    await run()

    expect(core.setOutput).toHaveBeenCalledWith('scan-status', 'COMPLETED')
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('could not be read'))
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('never passes a project ID through --name', async () => {
    process.env.GITHUB_REPOSITORY = 'FiniteStateInc/webgoat'
    setInputs({
      type: 'sca',
      file: '/tmp/app.jar',
      version: 'v1.2.3',
    })
    runQueue.push({ exitCode: 0, stdout: UPLOAD_LINE })

    await run()

    const args = execCalls[0].args
    expect(args).toEqual(expect.arrayContaining(['--name', 'webgoat', '--project-id', '42']))
    // the repository name stands in for the missing project name; the ID never does
    expect(args[args.indexOf('--name') + 1]).not.toBe('42')
  })

  it('fails when no project name can be derived', async () => {
    delete process.env.GITHUB_REPOSITORY
    setInputs({
      type: 'sca',
      file: '/tmp/app.jar',
      version: 'v1.2.3',
    })

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('A project name is required'),
    )
    expect(execCalls).toHaveLength(0)
  })

  it('fails when query exits 0 but reports a non-completed rollup', async () => {
    setInputs({
      type: 'sca',
      file: '/tmp/results.json',
      version: 'v1.2.3',
      'wait-for-completion': 'true',
    })
    runQueue.push(
      { exitCode: 0, stdout: UPLOAD_LINE },
      { exitCode: 0, stdout: scanJson({ total: 2, completed: 1, failed: 0 }) },
    )

    await run()

    expect(core.setOutput).toHaveBeenCalledWith('scan-status', 'RUNNING')
    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('Refusing to report success'),
    )
  })

  it('treats a rollup with non-numeric counts as unreadable', async () => {
    setInputs({
      type: 'sca',
      file: '/tmp/results.json',
      version: 'v1.2.3',
      'wait-for-completion': 'true',
    })
    runQueue.push(
      { exitCode: 0, stdout: UPLOAD_LINE },
      {
        exitCode: 0,
        stdout: JSON.stringify({ projectVersionId: 'ver-999', found: true, tests: {} }),
      },
    )

    await run()

    expect(core.setOutput).toHaveBeenCalledWith('scan-status', 'COMPLETED')
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('could not be read'))
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('ignores braces in log lines when reading the query JSON', async () => {
    setInputs({
      type: 'sca',
      file: '/tmp/results.json',
      version: 'v1.2.3',
      'wait-for-completion': 'true',
    })
    const noise = 'level=INFO msg="scan {pending} for {version}"\n'
    runQueue.push(
      { exitCode: 0, stdout: UPLOAD_LINE },
      { exitCode: 0, stdout: noise + scanJson({ total: 1, completed: 1, failed: 0 }) + '\n' },
    )

    await run()

    expect(core.setOutput).toHaveBeenCalledWith('scan-status', 'COMPLETED')
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('fails the step when fs-cli query reports a failed scan', async () => {
    setInputs({
      type: 'sca',
      file: '/tmp/results.json',
      version: 'v1.2.3',
      'wait-for-completion': 'true',
    })
    runQueue.push(
      { exitCode: 0, stdout: UPLOAD_LINE },
      { exitCode: 111, stdout: scanJson({ total: 2, completed: 1, failed: 1 }) },
    )

    await run()

    expect(core.setOutput).toHaveBeenCalledWith('scan-status', 'FAILED')
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('exit code 111'))
  })

  it('uses an existing version-id without asking fs-cli to create one', async () => {
    setInputs({
      type: 'sca',
      file: '/tmp/results.json',
      'version-id': 'ver-existing',
      'wait-for-completion': 'false',
    })

    await run()

    const upload = execCalls[0]
    expect(upload.args).toEqual(expect.arrayContaining(['--version-id', 'ver-existing']))
    expect(upload.args).not.toContain('--version')
    // no upload-complete line needed: the version ID was given
    expect(core.setOutput).toHaveBeenCalledWith('version-id', 'ver-existing')
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('skips the status query when wait-for-completion is false', async () => {
    setInputs({
      type: 'sca',
      file: '/tmp/results.json',
      version: 'v1.2.3',
      'wait-for-completion': 'false',
    })
    runQueue.push({ exitCode: 0, stdout: UPLOAD_LINE })

    await run()

    // upload only — no query call at all
    expect(execCalls).toHaveLength(1)
    expect(core.setOutput).toHaveBeenCalledWith('scan-status', 'SUBMITTED')
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('sends a comma-separated type list to fs-cli in one invocation', async () => {
    setInputs({
      type: 'sca,sast,config,vulnerability-analysis',
      file: '/tmp/app.jar',
      version: 'v1.2.3',
      'wait-for-completion': 'false',
    })
    runQueue.push({ exitCode: 0, stdout: UPLOAD_LINE })

    await run()

    // hyphens become underscores for fs-cli
    expect(execCalls[0].args).toEqual(
      expect.arrayContaining(['--type', 'sca,sast,config,vulnerability_analysis']),
    )
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('routes sbom uploads through fs-cli import', async () => {
    setInputs({
      type: 'sbom',
      'sbom-format': 'spdx',
      file: 'sbom.spdx.json',
      version: 'v1.2.3',
      'wait-for-completion': 'false',
    })
    runQueue.push({ exitCode: 0, stdout: 'Imported SBOM: project=proj-1 version=ver-999\n' })

    await run()

    const args = execCalls[0].args
    expect(args.slice(0, 2)).toEqual(['import', 'sbom.spdx.json'])
    expect(args).toEqual(expect.arrayContaining(['--format', 'spdx']))
    // import has no --timeout flag
    expect(args).not.toContain('--timeout')
    expect(core.setOutput).toHaveBeenCalledWith('version-id', 'ver-999')
  })

  it('routes third-party uploads through fs-cli third-party', async () => {
    setInputs({
      type: 'third-party',
      'scanner-type': 'grype',
      file: 'grype.json',
      version: 'v1.2.3',
      'wait-for-completion': 'false',
    })
    runQueue.push({ exitCode: 0, stdout: UPLOAD_LINE })

    await run()

    const args = execCalls[0].args
    expect(args.slice(0, 2)).toEqual(['third-party', 'grype.json'])
    expect(args).toEqual(expect.arrayContaining(['--type', 'grype']))
    expect(args).not.toContain('--timeout')
  })

  it('rejects mixing binary types with sbom', async () => {
    setInputs({
      type: 'sca,sbom',
      file: 'thing.json',
      version: 'v1.2.3',
      'wait-for-completion': 'false',
    })

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('different upload paths'))
    expect(execCalls).toHaveLength(0)
  })

  it('fails when fs-cli exits non-zero', async () => {
    runQueue.push({ exitCode: 1, stdout: '' })

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('exited with code 1'))
    expect(execCalls).toHaveLength(1)
  })

  it('fails when fs-cli output carries no version ID', async () => {
    runQueue.push({ exitCode: 0, stdout: 'uploading...\n' })

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('Could not read the version ID'),
    )
  })

  it('lets fs-cli find-or-create the project named by project-name', async () => {
    vi.mocked(readSetupContext).mockReturnValue({
      apiToken: 'standalone-token',
      domain: 'martinjones.finitestate.io',
      projectId: undefined,
      versionId: undefined,
    })
    setInputs({
      'api-token': 'standalone-token',
      domain: 'martinjones.finitestate.io',
      'project-name': 'WebGoat-BINARY',
      type: 'sca',
      file: '/tmp/app.jar',
      version: 'v1.2.3',
      'wait-for-completion': 'false',
    })
    runQueue.push({ exitCode: 0, stdout: UPLOAD_LINE })

    await run()

    expect(execCalls[0].args).toEqual(
      expect.arrayContaining(['--name', 'WebGoat-BINARY', '--version', 'v1.2.3']),
    )
    expect(execCalls[0].args).not.toContain('--project-id')
    expect(core.setSecret).toHaveBeenCalledWith('standalone-token')
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('warns that project-type is ignored', async () => {
    setInputs({
      type: 'sca',
      file: '/tmp/app.jar',
      version: 'v1.2.3',
      'project-type': 'application',
      'wait-for-completion': 'false',
    })
    runQueue.push({ exitCode: 0, stdout: UPLOAD_LINE })

    await run()

    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('project-type is ignored'))
  })

  it('fails when neither version nor version-id is given', async () => {
    setInputs({
      type: 'sca',
      file: '/tmp/app.jar',
      'wait-for-completion': 'false',
    })

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('version-id'))
    expect(execCalls).toHaveLength(0)
  })

  it('expands a glob that matches exactly one file', async () => {
    setInputs({
      type: 'sca',
      file: 'target/webgoat-*.jar',
      version: 'v1.2.3',
      'wait-for-completion': 'false',
    })
    mockGlobMatches.push('target/webgoat-2025.4.jar')
    runQueue.push({ exitCode: 0, stdout: UPLOAD_LINE })

    await run()

    expect(execCalls[0].args[1]).toBe('target/webgoat-2025.4.jar')
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('fails when a glob matches more than one file', async () => {
    setInputs({
      type: 'sca',
      file: 'target/webgoat-*.jar',
      version: 'v1.2.3',
      'wait-for-completion': 'false',
    })
    mockGlobMatches.push('target/webgoat-2025.4.jar', 'target/webgoat-2025.4-sources.jar')

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('matches 2 files'))
    expect(execCalls).toHaveLength(0)
  })

  it('fails with a clear error when a glob matches nothing', async () => {
    setInputs({
      type: 'sca',
      file: 'target/nope-*.jar',
      version: 'v1.2.3',
      'wait-for-completion': 'false',
    })

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('No file matches'))
  })
})
