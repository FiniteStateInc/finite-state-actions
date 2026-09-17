import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as core from '@actions/core'
import { writeSetupContext, readSetupContext } from '../src/context'

vi.mock('@actions/core')

describe('writeSetupContext', () => {
  beforeEach(() => {
    vi.mocked(core.exportVariable).mockReset()
    vi.mocked(core.setOutput).mockReset()
    vi.mocked(core.setSecret).mockReset()
  })

  it('exports token as secret and env var', () => {
    writeSetupContext({
      apiToken: 'test-token',
      domain: 'app.finitestate.io',
    })

    expect(core.setSecret).toHaveBeenCalledWith('test-token')
    expect(core.exportVariable).toHaveBeenCalledWith('FINITE_STATE_AUTH_TOKEN', 'test-token')
    expect(core.exportVariable).toHaveBeenCalledWith('FINITE_STATE_DOMAIN', 'app.finitestate.io')
  })

  it('exports optional project-id and version-id', () => {
    writeSetupContext({
      apiToken: 'test-token',
      domain: 'app.finitestate.io',
      projectId: '12345',
      versionId: '67890',
    })

    expect(core.exportVariable).toHaveBeenCalledWith('FINITE_STATE_PROJECT_ID', '12345')
    expect(core.exportVariable).toHaveBeenCalledWith('FINITE_STATE_VERSION_ID', '67890')
    expect(core.setOutput).toHaveBeenCalledWith('project-id', '12345')
    expect(core.setOutput).toHaveBeenCalledWith('version-id', '67890')
  })
})

describe('readSetupContext', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('reads context from environment variables', () => {
    process.env.FINITE_STATE_AUTH_TOKEN = 'env-token'
    process.env.FINITE_STATE_DOMAIN = 'customer.finitestate.io'
    process.env.FINITE_STATE_PROJECT_ID = '111'

    const ctx = readSetupContext()

    expect(ctx.apiToken).toBe('env-token')
    expect(ctx.domain).toBe('customer.finitestate.io')
    expect(ctx.projectId).toBe('111')
    expect(ctx.versionId).toBeUndefined()
  })

  it('allows input overrides over env', () => {
    process.env.FINITE_STATE_AUTH_TOKEN = 'env-token'
    process.env.FINITE_STATE_DOMAIN = 'customer.finitestate.io'
    process.env.FINITE_STATE_PROJECT_ID = '111'

    const ctx = readSetupContext({ projectId: '999' })

    expect(ctx.projectId).toBe('999')
    expect(ctx.apiToken).toBe('env-token')
  })

  it('throws if no API token available', () => {
    delete process.env.FINITE_STATE_AUTH_TOKEN
    expect(() => readSetupContext()).toThrow('FINITE_STATE_AUTH_TOKEN')
  })

  // core.getInput trims what it returns; an environment variable does not, so a
  // value assembled from a `vars.` expression or written by an earlier step can
  // arrive with a trailing newline.
  it('trims whitespace off environment values', () => {
    process.env.FINITE_STATE_AUTH_TOKEN = '  env-token\n'
    process.env.FINITE_STATE_DOMAIN = ' customer.finitestate.io \n'
    process.env.FINITE_STATE_VERSION_ID = '\tver-1\n'

    const ctx = readSetupContext()

    expect(ctx.apiToken).toBe('env-token')
    expect(ctx.domain).toBe('customer.finitestate.io')
    expect(ctx.versionId).toBe('ver-1')
  })

  it('treats a whitespace-only value as absent rather than as a value', () => {
    process.env.FINITE_STATE_AUTH_TOKEN = 'env-token'
    process.env.FINITE_STATE_DOMAIN = '   '
    process.env.FINITE_STATE_VERSION_ID = '\n'
    process.env.FINITE_STATE_PROJECT_ID = ' '

    const ctx = readSetupContext()

    // A blank version would otherwise be queried, and a blank domain would
    // build the URL https:// with nothing after it.
    expect(ctx.versionId).toBeUndefined()
    expect(ctx.projectId).toBeUndefined()
    expect(ctx.domain).toBe('app.finitestate.io')
  })

  it('throws when the token is only whitespace', () => {
    process.env.FINITE_STATE_AUTH_TOKEN = '   '
    expect(() => readSetupContext()).toThrow('FINITE_STATE_AUTH_TOKEN')
  })

  it('trims an override as well as an environment value', () => {
    process.env.FINITE_STATE_AUTH_TOKEN = 'env-token'

    const ctx = readSetupContext({ versionId: ' ver-2 ', domain: '' })

    expect(ctx.versionId).toBe('ver-2')
    // An empty override falls through to the env value, then the default.
    expect(ctx.domain).toBe('app.finitestate.io')
  })
})

describe('projectName round-trip', () => {
  beforeEach(() => {
    vi.mocked(core.exportVariable).mockReset()
    delete process.env.FINITE_STATE_PROJECT_NAME
  })

  afterEach(() => {
    delete process.env.FINITE_STATE_AUTH_TOKEN
    delete process.env.FINITE_STATE_PROJECT_NAME
  })

  it('exports the project name when set', () => {
    writeSetupContext({
      apiToken: 'test-token',
      domain: 'app.finitestate.io',
      projectName: 'WebGoat',
    })

    expect(core.exportVariable).toHaveBeenCalledWith('FINITE_STATE_PROJECT_NAME', 'WebGoat')
  })

  it('reads the project name back without a project ID', () => {
    process.env.FINITE_STATE_AUTH_TOKEN = 'test-token'
    process.env.FINITE_STATE_PROJECT_NAME = 'WebGoat'

    const ctx = readSetupContext()

    expect(ctx.projectName).toBe('WebGoat')
    expect(ctx.projectId).toBeUndefined()
  })
})
