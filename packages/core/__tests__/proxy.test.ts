import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Mock @actions/core ─────────────────────────────────────────────────────────

const mockInfo = vi.fn()
const mockWarning = vi.fn()

vi.mock('@actions/core', () => ({
  info: (...args: unknown[]) => mockInfo(...args),
  warning: (...args: unknown[]) => mockWarning(...args),
}))

// ── Imports (after mocks) ──────────────────────────────────────────────────────

import { EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'

// ── Helpers ───────────────────────────────────────────────────────────────────

const PROXY_VARS = [
  'https_proxy',
  'HTTPS_PROXY',
  'http_proxy',
  'HTTP_PROXY',
  'no_proxy',
  'NO_PROXY',
]

/** Fresh module state per test — useEnvProxy only acts on its first call. */
async function loadUseEnvProxy() {
  vi.resetModules()
  return (await import('../src/proxy')).useEnvProxy
}

const originalEnv: Record<string, string | undefined> = {}
let originalDispatcher: ReturnType<typeof getGlobalDispatcher>

beforeEach(() => {
  originalDispatcher = getGlobalDispatcher()
  for (const name of PROXY_VARS) {
    originalEnv[name] = process.env[name]
    delete process.env[name]
  }
  mockInfo.mockClear()
  mockWarning.mockClear()
})

afterEach(() => {
  setGlobalDispatcher(originalDispatcher)
  for (const name of PROXY_VARS) {
    if (originalEnv[name] === undefined) {
      delete process.env[name]
    } else {
      process.env[name] = originalEnv[name] as string
    }
  }
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('useEnvProxy', () => {
  it('leaves the dispatcher alone when no proxy is configured', async () => {
    const useEnvProxy = await loadUseEnvProxy()

    expect(useEnvProxy()).toBeUndefined()
    expect(getGlobalDispatcher()).toBe(originalDispatcher)
    expect(mockInfo).not.toHaveBeenCalled()
  })

  it('installs a proxy dispatcher from HTTPS_PROXY', async () => {
    process.env.HTTPS_PROXY = 'http://proxy.corp.example:3128'
    const useEnvProxy = await loadUseEnvProxy()

    expect(useEnvProxy()).toBe('http://proxy.corp.example:3128/')
    expect(getGlobalDispatcher()).toBeInstanceOf(EnvHttpProxyAgent)
    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('HTTPS_PROXY'))
  })

  it('reads the lower-case spelling too', async () => {
    process.env.http_proxy = 'http://proxy.corp.example:3128'
    const useEnvProxy = await loadUseEnvProxy()

    expect(useEnvProxy()).toBe('http://proxy.corp.example:3128/')
    expect(getGlobalDispatcher()).toBeInstanceOf(EnvHttpProxyAgent)
  })

  it('keeps proxy credentials out of the return value and the log', async () => {
    process.env.HTTPS_PROXY = 'http://user:s3cret@proxy.corp.example:3128'
    const useEnvProxy = await loadUseEnvProxy()

    const result = useEnvProxy() as string
    expect(result).not.toContain('s3cret')
    expect(result).toContain('***')
    expect(mockInfo.mock.calls.flat().join(' ')).not.toContain('s3cret')
  })

  it('only installs the dispatcher once', async () => {
    process.env.HTTPS_PROXY = 'http://proxy.corp.example:3128'
    const useEnvProxy = await loadUseEnvProxy()

    expect(useEnvProxy()).toBe('http://proxy.corp.example:3128/')
    const first = getGlobalDispatcher()

    expect(useEnvProxy()).toBe('http://proxy.corp.example:3128/')
    expect(getGlobalDispatcher()).toBe(first)
  })

  it('warns and carries on when the proxy URL is malformed', async () => {
    process.env.HTTPS_PROXY = 'not a url'
    const useEnvProxy = await loadUseEnvProxy()

    expect(useEnvProxy()).toBeUndefined()
    expect(getGlobalDispatcher()).toBe(originalDispatcher)
    expect(mockWarning).toHaveBeenCalledWith(expect.stringContaining('HTTPS_PROXY'))
  })
})
