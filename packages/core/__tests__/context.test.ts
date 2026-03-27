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
    expect(core.exportVariable).toHaveBeenCalledWith('FS_API_TOKEN', 'test-token')
    expect(core.exportVariable).toHaveBeenCalledWith('FS_DOMAIN', 'app.finitestate.io')
  })

  it('exports optional project-id and version-id', () => {
    writeSetupContext({
      apiToken: 'test-token',
      domain: 'app.finitestate.io',
      projectId: '12345',
      versionId: '67890',
    })

    expect(core.exportVariable).toHaveBeenCalledWith('FS_PROJECT_ID', '12345')
    expect(core.exportVariable).toHaveBeenCalledWith('FS_VERSION_ID', '67890')
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
    process.env.FS_API_TOKEN = 'env-token'
    process.env.FS_DOMAIN = 'customer.finitestate.io'
    process.env.FS_PROJECT_ID = '111'

    const ctx = readSetupContext()

    expect(ctx.apiToken).toBe('env-token')
    expect(ctx.domain).toBe('customer.finitestate.io')
    expect(ctx.projectId).toBe('111')
    expect(ctx.versionId).toBeUndefined()
  })

  it('allows input overrides over env', () => {
    process.env.FS_API_TOKEN = 'env-token'
    process.env.FS_DOMAIN = 'customer.finitestate.io'
    process.env.FS_PROJECT_ID = '111'

    const ctx = readSetupContext({ projectId: '999' })

    expect(ctx.projectId).toBe('999')
    expect(ctx.apiToken).toBe('env-token')
  })

  it('throws if no API token available', () => {
    expect(() => readSetupContext()).toThrow('FS_API_TOKEN')
  })
})
