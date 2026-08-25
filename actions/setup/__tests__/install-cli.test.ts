import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Mock @actions/core ─────────────────────────────────────────────────────────

vi.mock('@actions/core', () => ({
  addPath: vi.fn(),
  info: vi.fn(),
}))

// ── Mock node:fs/promises ──────────────────────────────────────────────────────

const mockMkdir = vi.fn()
const mockWriteFile = vi.fn()
const mockChmod = vi.fn()

vi.mock('node:fs/promises', () => ({
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  chmod: (...args: unknown[]) => mockChmod(...args),
}))

// ── Imports (after mocks) ──────────────────────────────────────────────────────

import * as core from '@actions/core'
import { installFsCli } from '../src/install-cli'
import type { FsClient } from '@finite-state/core'

// ── Helpers ───────────────────────────────────────────────────────────────────

const BINARY = new Uint8Array([0x7f, 0x45, 0x4c, 0x46])

function makeClient(downloadUrl = 'https://cdn.example.com/fs-cli?sig=abc') {
  return {
    getCliDownloadUrl: vi.fn().mockResolvedValue({ download_url: downloadUrl }),
  } as unknown as FsClient & { getCliDownloadUrl: ReturnType<typeof vi.fn> }
}

function stubPlatform(platform: string, arch: string) {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform as NodeJS.Platform)
  vi.spyOn(process, 'arch', 'get').mockReturnValue(arch as NodeJS.Architecture)
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('installFsCli', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.RUNNER_TEMP = '/runner/temp'
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: async () => BINARY.buffer,
      }),
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    delete process.env.RUNNER_TEMP
  })

  it('downloads the binary for the runner platform and adds it to PATH', async () => {
    stubPlatform('linux', 'x64')
    const client = makeClient()

    const binary = await installFsCli(client)

    expect(client.getCliDownloadUrl).toHaveBeenCalledWith('linux', 'amd64')
    expect(fetch).toHaveBeenCalledWith('https://cdn.example.com/fs-cli?sig=abc')
    expect(mockMkdir).toHaveBeenCalledWith('/runner/temp/fs-cli', { recursive: true })
    expect(mockWriteFile).toHaveBeenCalledWith('/runner/temp/fs-cli/fs-cli', expect.anything())
    expect(mockChmod).toHaveBeenCalledWith('/runner/temp/fs-cli/fs-cli', 0o755)
    expect(core.addPath).toHaveBeenCalledWith('/runner/temp/fs-cli')
    expect(binary).toBe('/runner/temp/fs-cli/fs-cli')
  })

  it('maps darwin/arm64 runners to the platform naming', async () => {
    stubPlatform('darwin', 'arm64')
    const client = makeClient()

    await installFsCli(client)

    expect(client.getCliDownloadUrl).toHaveBeenCalledWith('darwin', 'arm64')
  })

  it('uses the .exe suffix on Windows runners', async () => {
    stubPlatform('win32', 'x64')
    const client = makeClient()

    const binary = await installFsCli(client)

    expect(client.getCliDownloadUrl).toHaveBeenCalledWith('windows', 'amd64')
    expect(binary.endsWith('fs-cli.exe')).toBe(true)
  })

  it('throws on an unsupported platform', async () => {
    stubPlatform('freebsd', 'x64')

    await expect(installFsCli(makeClient())).rejects.toThrow(/not available for this runner/)
  })

  it('throws when the download URL returns a non-2xx status', async () => {
    stubPlatform('linux', 'x64')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }))

    await expect(installFsCli(makeClient())).rejects.toThrow(/HTTP 403/)
    expect(core.addPath).not.toHaveBeenCalled()
  })
})
