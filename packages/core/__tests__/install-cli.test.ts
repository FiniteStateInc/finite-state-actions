import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Mock @actions/core ─────────────────────────────────────────────────────────

vi.mock('@actions/core', () => ({
  addPath: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}))

// ── Mock node:fs/promises ──────────────────────────────────────────────────────

const mockMkdir = vi.fn()
const mockWriteFile = vi.fn()
const mockChmod = vi.fn()

const mockAccess = vi.fn()
const mockOpen = vi.fn()

vi.mock('node:fs/promises', () => ({
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  chmod: (...args: unknown[]) => mockChmod(...args),
  access: (...args: unknown[]) => mockAccess(...args),
  open: (...args: unknown[]) => mockOpen(...args),
}))

// ── Imports (after mocks) ──────────────────────────────────────────────────────

import * as core from '@actions/core'
import { installFsCli, ensureFsCli } from '../src/install-cli'
import type { FsClient } from '../src/client'

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal ELF header: magic, then e_machine at 0x12 (0x3e = amd64). */
function elf(machine = 0x3e): Uint8Array {
  const b = Buffer.alloc(64)
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(b)
  b.writeUInt16LE(machine, 0x12)
  return b
}

/** Minimal 64-bit little-endian Mach-O: magic, then cputype at 4. */
function macho(cpu = 0x01000007): Uint8Array {
  const b = Buffer.alloc(64)
  b.writeUInt32BE(0xcffaedfe, 0)
  b.writeUInt32LE(cpu, 4)
  return b
}

/** Minimal PE: 'MZ', PE header offset at 0x3c, machine after the signature. */
function pe(machine = 0x8664): Uint8Array {
  const b = Buffer.alloc(128)
  b[0] = 0x4d
  b[1] = 0x5a
  b.writeUInt32LE(0x40, 0x3c)
  Buffer.from([0x50, 0x45, 0x00, 0x00]).copy(b, 0x40)
  b.writeUInt16LE(machine, 0x44)
  return b
}

const BINARY = elf()

function makeClient(downloadUrl = 'https://cdn.example.com/fs-cli?sig=abc', version = 'v2.3.30') {
  return {
    getCliDownloadUrl: vi.fn().mockResolvedValue({ download_url: downloadUrl, version }),
  } as unknown as FsClient & { getCliDownloadUrl: ReturnType<typeof vi.fn> }
}

/** Makes `fs.open` serve `bytes` as the head of any file that is opened. */
function onDisk(bytes: Uint8Array): void {
  mockOpen.mockResolvedValue({
    read: async (buffer: Buffer) => {
      Buffer.from(bytes).copy(buffer)
      return { bytesRead: bytes.length }
    },
    close: async () => undefined,
  })
}

/** Points the stubbed fetch at a specific payload. */
function serve(bytes: Uint8Array): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
    }),
  )
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
    serve(BINARY)
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
    serve(macho(0x0100000c))
    const client = makeClient()

    await installFsCli(client)

    expect(client.getCliDownloadUrl).toHaveBeenCalledWith('darwin', 'arm64')
  })

  it('uses the .exe suffix on Windows runners', async () => {
    stubPlatform('win32', 'x64')
    serve(pe())
    const client = makeClient()

    const binary = await installFsCli(client)

    expect(client.getCliDownloadUrl).toHaveBeenCalledWith('windows', 'amd64')
    expect(binary.endsWith('fs-cli.exe')).toBe(true)
  })

  it('logs the version and platform it is installing', async () => {
    stubPlatform('linux', 'x64')
    const client = makeClient('https://cdn.example.com/fs-cli', 'v2.3.30')

    await installFsCli(client)

    expect(core.info).toHaveBeenCalledWith(expect.stringContaining('v2.3.30'))
    expect(core.info).toHaveBeenCalledWith(expect.stringContaining('linux/amd64'))
  })

  it('rejects a binary built for another operating system', async () => {
    stubPlatform('linux', 'x64')
    serve(pe())

    await expect(installFsCli(makeClient())).rejects.toThrow(/is a windows binary/)
    expect(mockWriteFile).not.toHaveBeenCalled()
    expect(core.addPath).not.toHaveBeenCalled()
  })

  it('rejects a binary built for another architecture', async () => {
    stubPlatform('linux', 'x64')
    serve(elf(0xb7))

    await expect(installFsCli(makeClient())).rejects.toThrow(/built for arm64/)
    expect(mockWriteFile).not.toHaveBeenCalled()
  })

  it('rejects an error page served in place of the binary', async () => {
    stubPlatform('linux', 'x64')
    serve(new TextEncoder().encode('{"error":"no release for this platform"}'))

    await expect(installFsCli(makeClient())).rejects.toThrow(/looks like JSON/)
    expect(mockWriteFile).not.toHaveBeenCalled()
  })

  it('verifies the architecture of a byte-swapped Mach-O rather than skipping it', async () => {
    stubPlatform('darwin', 'arm64')
    const swapped = Buffer.alloc(64)
    swapped.writeUInt32BE(0xfeedfacf, 0)
    swapped.writeUInt32BE(0x01000007, 4) // amd64, on an arm64 runner
    serve(swapped)

    await expect(installFsCli(makeClient())).rejects.toThrow(/built for amd64/)
  })

  it('rejects an unrecognised machine value instead of accepting it unchecked', async () => {
    stubPlatform('linux', 'x64')
    serve(elf(0xf3)) // riscv

    await expect(installFsCli(makeClient())).rejects.toThrow(/does not recognise/)
    expect(mockWriteFile).not.toHaveBeenCalled()
  })

  it('rejects a DOS stub with no PE signature', async () => {
    stubPlatform('win32', 'x64')
    const stub = Buffer.alloc(128)
    stub[0] = 0x4d
    stub[1] = 0x5a
    stub.writeUInt32LE(0x40, 0x3c) // points at zeroes, not 'PE\0\0'
    serve(stub)

    await expect(installFsCli(makeClient())).rejects.toThrow(/not an executable/)
    expect(mockWriteFile).not.toHaveBeenCalled()
  })

  it('fails when the platform returns no download URL', async () => {
    stubPlatform('linux', 'x64')
    const client = {
      getCliDownloadUrl: vi.fn().mockResolvedValue({ version: 'v2.3.30' }),
    } as unknown as FsClient

    await expect(installFsCli(client)).rejects.toThrow(/no download URL/)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('accepts a universal macOS binary, which pins no single architecture', async () => {
    stubPlatform('darwin', 'arm64')
    const fat = Buffer.alloc(64)
    fat.writeUInt32BE(0xcafebabe, 0)
    serve(fat)

    await expect(installFsCli(makeClient())).resolves.toContain('fs-cli')
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

describe('ensureFsCli', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.RUNNER_TEMP = '/runner/temp'
    process.env.PATH = '/usr/local/bin:/usr/bin'
    serve(BINARY)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    delete process.env.RUNNER_TEMP
  })

  it('reuses an fs-cli already on PATH when it matches the runner', async () => {
    stubPlatform('linux', 'x64')
    mockAccess.mockImplementation(async (candidate: string) => {
      if (candidate !== '/usr/local/bin/fs-cli') throw new Error('ENOENT')
    })
    onDisk(elf())
    const client = makeClient()

    const binary = await ensureFsCli(client)

    expect(binary).toBe('/usr/local/bin/fs-cli')
    expect(client.getCliDownloadUrl).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('replaces an fs-cli on PATH that was built for another platform', async () => {
    stubPlatform('linux', 'x64')
    mockAccess.mockImplementation(async (candidate: string) => {
      if (candidate !== '/usr/local/bin/fs-cli') throw new Error('ENOENT')
    })
    onDisk(pe())
    const client = makeClient()

    const binary = await ensureFsCli(client)

    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Ignoring the fs-cli on PATH'),
    )
    expect(client.getCliDownloadUrl).toHaveBeenCalledWith('linux', 'amd64')
    expect(binary).toBe('/runner/temp/fs-cli/fs-cli')
  })

  it('downloads when an fs-cli on PATH cannot be read', async () => {
    stubPlatform('linux', 'x64')
    mockAccess.mockImplementation(async (candidate: string) => {
      if (candidate !== '/usr/local/bin/fs-cli') throw new Error('ENOENT')
    })
    mockOpen.mockRejectedValue(new Error('EACCES'))
    const client = makeClient()

    const binary = await ensureFsCli(client)

    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('could not be read'))
    expect(binary).toBe('/runner/temp/fs-cli/fs-cli')
  })

  it('downloads fs-cli when PATH has none', async () => {
    stubPlatform('linux', 'x64')
    mockAccess.mockRejectedValue(new Error('ENOENT'))
    const client = makeClient()

    const binary = await ensureFsCli(client)

    expect(client.getCliDownloadUrl).toHaveBeenCalledWith('linux', 'amd64')
    expect(binary).toBe('/runner/temp/fs-cli/fs-cli')
  })
})
