import { describe, it, expect, vi, afterEach } from 'vitest'
import { FsClient, isProjectId, resolveProjectId } from '../src/client'
import type { AuthUser, Project, Version, Scan } from '../src/models'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFetch(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })
}

// ── Constructor ───────────────────────────────────────────────────────────────

describe('FsClient constructor', () => {
  it('builds correct base URL from domain', () => {
    const client = new FsClient({ apiToken: 'tok', domain: 'platform.example.com' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((client as any).baseUrl).toBe('https://platform.example.com/api/public/v0')
  })

  it('stores X-Authorization header', () => {
    const client = new FsClient({ apiToken: 'mytoken', domain: 'example.com' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((client as any).headers['X-Authorization']).toBe('mytoken')
  })
})

// ── getAuthUser ───────────────────────────────────────────────────────────────

describe('getAuthUser', () => {
  afterEach(() => vi.restoreAllMocks())

  it('calls GET /authUser with X-Authorization header', async () => {
    const authUser: AuthUser = { id: 'u1', email: 'user@example.com', organizationId: 'org1' }
    const mockFetch = makeFetch(authUser)
    vi.stubGlobal('fetch', mockFetch)

    const client = new FsClient({ apiToken: 'tok123', domain: 'example.com' })
    const result = await client.getAuthUser()

    expect(mockFetch).toHaveBeenCalledOnce()
    const [url, opts] = mockFetch.mock.calls[0]
    expect(url).toBe('https://example.com/api/public/v0/authUser')
    expect(opts.method).toBe('GET')
    expect(opts.headers['X-Authorization']).toBe('tok123')
    expect(result).toEqual(authUser)
  })
})

// ── createVersion ─────────────────────────────────────────────────────────────

describe('createVersion', () => {
  afterEach(() => vi.restoreAllMocks())

  it('POSTs to /projects/{id}/versions with version body', async () => {
    const version: Version = { id: 'v1', name: 'v1.0', projectId: 'proj1', createdAt: '2026-01-01' }
    const mockFetch = makeFetch(version)
    vi.stubGlobal('fetch', mockFetch)

    const client = new FsClient({ apiToken: 'tok', domain: 'example.com' })
    const result = await client.createVersion('proj1', 'v1.0')

    expect(mockFetch).toHaveBeenCalledOnce()
    const [url, opts] = mockFetch.mock.calls[0]
    expect(url).toBe('https://example.com/api/public/v0/projects/proj1/versions')
    expect(opts.method).toBe('POST')
    expect(JSON.parse(opts.body)).toEqual({ version: 'v1.0' })
    expect(result).toEqual(version)
  })
})

// ── uploadScan ────────────────────────────────────────────────────────────────

describe('uploadScan', () => {
  afterEach(() => vi.restoreAllMocks())

  it('routes sca scan to POST /scans', async () => {
    const mockFetch = makeFetch({ id: 'scan1' })
    vi.stubGlobal('fetch', mockFetch)

    const client = new FsClient({ apiToken: 'tok', domain: 'example.com' })
    const data = new Uint8Array([1, 2, 3])
    const result = await client.uploadScan({
      type: 'sca',
      filename: 'scan.zip',
      projectVersionId: 'pv1',
      data,
    })

    const [url, opts] = mockFetch.mock.calls[0]
    expect(url).toBe(
      'https://example.com/api/public/v0/scans?type=sca&filename=scan.zip&projectVersionId=pv1',
    )
    expect(opts.method).toBe('POST')
    expect(opts.headers['Content-Type']).toBe('application/octet-stream')
    expect(result).toEqual({ id: 'scan1' })
  })

  it('routes vulnerability-analysis scan to /scans with query type=vulnerability_analysis', async () => {
    const mockFetch = makeFetch({ id: 'scan2' })
    vi.stubGlobal('fetch', mockFetch)

    const client = new FsClient({ apiToken: 'tok', domain: 'example.com' })
    await client.uploadScan({
      type: 'vulnerability-analysis',
      filename: 'vuln.zip',
      projectVersionId: 'pv2',
      data: new Uint8Array(),
    })

    const [url] = mockFetch.mock.calls[0]
    expect(url).toContain('/scans?')
    expect(url).toContain('type=vulnerability_analysis')
  })

  it('routes sbom scan to POST /scans/sbom', async () => {
    const mockFetch = makeFetch({ id: 'scan3' })
    vi.stubGlobal('fetch', mockFetch)

    const client = new FsClient({ apiToken: 'tok', domain: 'example.com' })
    await client.uploadScan({
      type: 'sbom',
      filename: 'sbom.json',
      projectVersionId: 'pv3',
      data: new Uint8Array(),
      sbomFormat: 'cyclonedx',
    })

    const [url] = mockFetch.mock.calls[0]
    expect(url).toContain('/scans/sbom?')
    expect(url).toContain('type=cyclonedx')
  })

  it('routes third-party scan to POST /scans/third-party', async () => {
    const mockFetch = makeFetch({ id: 'scan4' })
    vi.stubGlobal('fetch', mockFetch)

    const client = new FsClient({ apiToken: 'tok', domain: 'example.com' })
    await client.uploadScan({
      type: 'third-party',
      filename: 'third.json',
      projectVersionId: 'pv4',
      data: new Uint8Array(),
      scannerType: 'my-scanner',
    })

    const [url] = mockFetch.mock.calls[0]
    expect(url).toContain('/scans/third-party?')
    expect(url).toContain('type=my-scanner')
  })
})

// ── getScanStatus ─────────────────────────────────────────────────────────────

describe('getScanStatus', () => {
  afterEach(() => vi.restoreAllMocks())

  it('fetches with correct filter query params (array response)', async () => {
    const scan: Scan = {
      id: 's1',
      scanType: 'sca',
      status: 'COMPLETED',
      createdAt: '2026-01-01',
      versionId: 'pv1',
    }
    const mockFetch = makeFetch([scan])
    vi.stubGlobal('fetch', mockFetch)

    const client = new FsClient({ apiToken: 'tok', domain: 'example.com' })
    const result = await client.getScanStatus('pv1')

    const [url] = mockFetch.mock.calls[0]
    expect(url).toContain('filter=projectVersion%3D%3Dpv1')
    expect(url).toContain('sort=created%3Adesc')
    expect(url).toContain('limit=1')
    expect(result).toEqual(scan)
  })

  it('handles wrapped { scans: [...] } response', async () => {
    const scan: Scan = {
      id: 's2',
      scanType: 'sast',
      status: 'RUNNING',
      createdAt: '2026-01-01',
      versionId: 'pv2',
    }
    const mockFetch = makeFetch({ scans: [scan] })
    vi.stubGlobal('fetch', mockFetch)

    const client = new FsClient({ apiToken: 'tok', domain: 'example.com' })
    const result = await client.getScanStatus('pv2')

    expect(result).toEqual(scan)
  })
})

// ── downloadSbom ──────────────────────────────────────────────────────────────

describe('downloadSbom', () => {
  afterEach(() => vi.restoreAllMocks())

  it('calls GET /sboms/{format}/{pvId}?includeVex={bool}', async () => {
    const sbomData = { bomFormat: 'CycloneDX', components: [] }
    const mockFetch = makeFetch(sbomData)
    vi.stubGlobal('fetch', mockFetch)

    const client = new FsClient({ apiToken: 'tok', domain: 'example.com' })
    const result = await client.downloadSbom('pv1', 'cyclonedx', true)

    const [url, opts] = mockFetch.mock.calls[0]
    expect(url).toBe('https://example.com/api/public/v0/sboms/cyclonedx/pv1?includeVex=true')
    expect(opts.method).toBe('GET')
    expect(result).toEqual(sbomData)
  })

  it('passes includeVex=false correctly', async () => {
    const mockFetch = makeFetch({})
    vi.stubGlobal('fetch', mockFetch)

    const client = new FsClient({ apiToken: 'tok', domain: 'example.com' })
    await client.downloadSbom('pv2', 'spdx', false)

    const [url] = mockFetch.mock.calls[0]
    expect(url).toContain('includeVex=false')
  })
})

// ── Error handling ────────────────────────────────────────────────────────────

describe('error handling', () => {
  afterEach(() => vi.restoreAllMocks())

  it('throws helpful message on 401', async () => {
    const mockFetch = makeFetch({ message: 'Unauthorized' }, 401)
    vi.stubGlobal('fetch', mockFetch)

    const client = new FsClient({ apiToken: 'bad-token', domain: 'example.com' })
    await expect(client.getAuthUser()).rejects.toThrow(/401|unauthorized|token/i)
  })

  it('throws on 403', async () => {
    const mockFetch = makeFetch({ message: 'Forbidden' }, 403)
    vi.stubGlobal('fetch', mockFetch)

    const client = new FsClient({ apiToken: 'tok', domain: 'example.com' })
    await expect(client.getAuthUser()).rejects.toThrow()
  })

  it('throws on 404', async () => {
    const mockFetch = makeFetch({ message: 'Not Found' }, 404)
    vi.stubGlobal('fetch', mockFetch)

    const client = new FsClient({ apiToken: 'tok', domain: 'example.com' })
    await expect(client.getAuthUser()).rejects.toThrow()
  })

  it('throws on 500 without retrying', async () => {
    const mockFetch = makeFetch({ message: 'Server Error' }, 500)
    vi.stubGlobal('fetch', mockFetch)

    const client = new FsClient({ apiToken: 'tok', domain: 'example.com' })
    await expect(client.getAuthUser()).rejects.toThrow()
    // 500 should NOT be retried — called only once
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })
})

// ── Retry logic ───────────────────────────────────────────────────────────────

describe('retry logic', () => {
  afterEach(() => vi.restoreAllMocks())

  it('retries on 429 and eventually succeeds', async () => {
    vi.useFakeTimers()

    const authUser: AuthUser = { id: 'u1', email: 'a@b.com', organizationId: 'o1' }
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        json: async () => ({}),
        text: async () => '{}',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => authUser,
        text: async () => JSON.stringify(authUser),
      })

    vi.stubGlobal('fetch', mockFetch)

    const client = new FsClient({ apiToken: 'tok', domain: 'example.com' })
    const promise = client.getAuthUser()

    // Advance timers to let exponential backoff resolve
    await vi.runAllTimersAsync()

    const result = await promise
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(result).toEqual(authUser)

    vi.useRealTimers()
  })

  it('retries on 503 up to max retries and then throws', async () => {
    vi.useFakeTimers()

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
      text: async () => '{}',
    })
    vi.stubGlobal('fetch', mockFetch)

    const client = new FsClient({ apiToken: 'tok', domain: 'example.com' })
    let caughtError: Error | undefined

    const promise = client.getAuthUser().catch((e) => {
      caughtError = e
    })

    await vi.runAllTimersAsync()
    await promise

    expect(caughtError).toBeDefined()
    expect(caughtError?.message).toMatch(/503/)
    // Should have attempted 1 + 6 = 7 calls (initial + 6 retries)
    expect(mockFetch).toHaveBeenCalledTimes(7)

    vi.useRealTimers()
  })
})

// ── pollScanCompletion ────────────────────────────────────────────────────────

describe('pollScanCompletion', () => {
  afterEach(() => vi.restoreAllMocks())

  it('resolves when scan reaches COMPLETED', async () => {
    vi.useFakeTimers()

    const runningScan: Scan = {
      id: 's1',
      scanType: 'sca',
      status: 'RUNNING',
      createdAt: '2026-01-01',
      versionId: 'pv1',
    }
    const completedScan: Scan = {
      id: 's1',
      scanType: 'sca',
      status: 'COMPLETED',
      createdAt: '2026-01-01',
      versionId: 'pv1',
    }

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [runningScan],
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [completedScan],
        text: async () => '',
      })

    vi.stubGlobal('fetch', mockFetch)

    const client = new FsClient({ apiToken: 'tok', domain: 'example.com' })
    const promise = client.pollScanCompletion('pv1', 60_000, 1_000)

    await vi.runAllTimersAsync()

    const result = await promise
    expect(result.status).toBe('COMPLETED')

    vi.useRealTimers()
  })

  it('rejects when scan reaches FAILED', async () => {
    vi.useFakeTimers()

    const failedScan: Scan = {
      id: 's1',
      scanType: 'sca',
      status: 'FAILED',
      createdAt: '2026-01-01',
      versionId: 'pv1',
    }
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [failedScan],
      text: async () => '',
    })

    vi.stubGlobal('fetch', mockFetch)

    const client = new FsClient({ apiToken: 'tok', domain: 'example.com' })
    let caughtError: Error | undefined
    const promise = client.pollScanCompletion('pv1', 60_000, 1_000).catch((e) => {
      caughtError = e
    })

    await vi.runAllTimersAsync()
    await promise

    expect(caughtError).toBeDefined()
    expect(caughtError?.message).toMatch(/failed/i)

    vi.useRealTimers()
  })

  it('rejects when timeout is reached', async () => {
    vi.useFakeTimers()

    const runningScan: Scan = {
      id: 's1',
      scanType: 'sca',
      status: 'RUNNING',
      createdAt: '2026-01-01',
      versionId: 'pv1',
    }
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [runningScan],
      text: async () => '',
    })

    vi.stubGlobal('fetch', mockFetch)

    const client = new FsClient({ apiToken: 'tok', domain: 'example.com' })
    // 5s timeout, 2s interval → 3 polls before timeout
    let caughtError: Error | undefined
    const promise = client.pollScanCompletion('pv1', 5_000, 2_000).catch((e) => {
      caughtError = e
    })

    await vi.runAllTimersAsync()
    await promise

    expect(caughtError).toBeDefined()
    expect(caughtError?.message).toMatch(/timeout/i)

    vi.useRealTimers()
  })
})

// ── listProjects ─────────────────────────────────────────────────────────────

describe('listProjects', () => {
  afterEach(() => vi.restoreAllMocks())

  it('calls GET /projects with name filter', async () => {
    const projects: Project[] = [{ id: 'p1', name: 'WebGoat', organizationId: 'org1' }]
    const mockFetch = makeFetch(projects)
    vi.stubGlobal('fetch', mockFetch)

    const client = new FsClient({ apiToken: 'tok', domain: 'example.com' })
    const result = await client.listProjects('WebGoat')

    const [url] = mockFetch.mock.calls[0]
    expect(url).toContain('/projects?')
    expect(url).toContain('filter=name%3D%3DWebGoat')
    expect(result).toEqual(projects)
  })

  it('handles wrapped { projects: [...] } response', async () => {
    const projects: Project[] = [{ id: 'p1', name: 'MyProject', organizationId: 'org1' }]
    const mockFetch = makeFetch({ projects })
    vi.stubGlobal('fetch', mockFetch)

    const client = new FsClient({ apiToken: 'tok', domain: 'example.com' })
    const result = await client.listProjects('MyProject')

    expect(result).toEqual(projects)
  })

  it('calls GET /projects without filter when no name given', async () => {
    const mockFetch = makeFetch([])
    vi.stubGlobal('fetch', mockFetch)

    const client = new FsClient({ apiToken: 'tok', domain: 'example.com' })
    await client.listProjects()

    const [url] = mockFetch.mock.calls[0]
    expect(url).toBe('https://example.com/api/public/v0/projects')
  })
})

// ── isProjectId ──────────────────────────────────────────────────────────────

describe('isProjectId', () => {
  it('returns true for valid UUIDs', () => {
    expect(isProjectId('123e4567-e89b-12d3-a456-426614174000')).toBe(true)
    expect(isProjectId('A1B2C3D4-E5F6-7890-ABCD-EF1234567890')).toBe(true)
  })

  it('returns false for project names', () => {
    expect(isProjectId('WebGoat')).toBe(false)
    expect(isProjectId('my-project')).toBe(false)
    expect(isProjectId('')).toBe(false)
  })
})

// ── resolveProjectId ─────────────────────────────────────────────────────────

describe('resolveProjectId', () => {
  afterEach(() => vi.restoreAllMocks())

  it('returns UUID as-is without API call', async () => {
    const mockFetch = makeFetch([])
    vi.stubGlobal('fetch', mockFetch)

    const client = new FsClient({ apiToken: 'tok', domain: 'example.com' })
    const result = await resolveProjectId(client, '123e4567-e89b-12d3-a456-426614174000')

    expect(result).toBe('123e4567-e89b-12d3-a456-426614174000')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('resolves project name to ID via API', async () => {
    const projects: Project[] = [
      { id: 'p1-uuid-here-0000-000000000000', name: 'WebGoat', organizationId: 'org1' },
    ]
    const mockFetch = makeFetch(projects)
    vi.stubGlobal('fetch', mockFetch)

    const client = new FsClient({ apiToken: 'tok', domain: 'example.com' })
    const result = await resolveProjectId(client, 'WebGoat')

    expect(result).toBe('p1-uuid-here-0000-000000000000')
  })

  it('throws when no project matches the name', async () => {
    const mockFetch = makeFetch([])
    vi.stubGlobal('fetch', mockFetch)

    const client = new FsClient({ apiToken: 'tok', domain: 'example.com' })
    await expect(resolveProjectId(client, 'NonExistent')).rejects.toThrow(
      /No project found with name "NonExistent"/,
    )
  })

  it('throws when multiple projects match the name', async () => {
    const projects: Project[] = [
      { id: 'p1', name: 'WebGoat', organizationId: 'org1' },
      { id: 'p2', name: 'WebGoat', organizationId: 'org1' },
    ]
    const mockFetch = makeFetch(projects)
    vi.stubGlobal('fetch', mockFetch)

    const client = new FsClient({ apiToken: 'tok', domain: 'example.com' })
    await expect(resolveProjectId(client, 'WebGoat')).rejects.toThrow(
      /Multiple projects match name "WebGoat"/,
    )
  })
})
