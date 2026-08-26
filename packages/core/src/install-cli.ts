import * as core from '@actions/core'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { constants as fsConstants } from 'node:fs'
import type { FsClient } from './client'

// ── Platform mapping ──────────────────────────────────────────────────────────

const OS_NAMES: Record<string, string> = {
  linux: 'linux',
  darwin: 'darwin',
  win32: 'windows',
}

const ARCH_NAMES: Record<string, string> = {
  x64: 'amd64',
  arm64: 'arm64',
}

// ── Downloaded-binary verification ────────────────────────────────────────────

/**
 * The OS and CPU a binary was built for, read from its executable header.
 * `arch` is undefined when the format carries no single architecture (a
 * universal Mach-O) or an unrecognised machine value.
 */
interface BinaryTarget {
  os: string
  arch?: string
}

const ELF_MACHINES: Record<number, string> = { 0x3e: 'amd64', 0xb7: 'arm64' }
const MACHO_CPUS: Record<number, string> = { 0x01000007: 'amd64', 0x0100000c: 'arm64' }
const PE_MACHINES: Record<number, string> = { 0x8664: 'amd64', 0xaa64: 'arm64' }

/**
 * Identifies what a downloaded file actually is, so a Linux build landing on a
 * Windows runner (or a JSON error page saved as the binary) fails here with a
 * clear message instead of as an unreadable exec error two steps later.
 *
 * Returns undefined when the bytes are not a recognised executable at all.
 */
function sniffBinaryTarget(bytes: Buffer): BinaryTarget | undefined {
  // ELF: 0x7f 'E' 'L' 'F', e_machine is a little-endian u16 at 0x12.
  if (bytes.length > 0x14 && bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    return { os: 'linux', arch: ELF_MACHINES[bytes.readUInt16LE(0x12)] }
  }

  // Mach-O: 64-bit little-endian thin binary carries cputype at offset 4.
  if (bytes.length > 8) {
    const magic = bytes.readUInt32BE(0)
    if (magic === 0xcffaedfe || magic === 0xcefaedfe) {
      return { os: 'darwin', arch: MACHO_CPUS[bytes.readUInt32LE(4)] }
    }
    // Big-endian thin and universal ("fat") binaries: OS is certain, the
    // architecture is not one value.
    if (magic === 0xfeedfacf || magic === 0xfeedface || magic === 0xcafebabe) {
      return { os: 'darwin' }
    }
  }

  // PE: 'MZ', then the PE header offset as a little-endian u32 at 0x3c.
  if (bytes.length > 0x40 && bytes[0] === 0x4d && bytes[1] === 0x5a) {
    const peOffset = bytes.readUInt32LE(0x3c)
    if (
      bytes.length > peOffset + 6 &&
      bytes.subarray(peOffset, peOffset + 4).equals(Buffer.from([0x50, 0x45, 0x00, 0x00]))
    ) {
      return { os: 'windows', arch: PE_MACHINES[bytes.readUInt16LE(peOffset + 4)] }
    }
    return { os: 'windows' }
  }

  return undefined
}

/** A short, safe description of bytes that are not an executable. */
function describeNonBinary(bytes: Buffer): string {
  const head = bytes.subarray(0, 200).toString('utf8').trim()
  if (head.startsWith('{') || head.startsWith('[')) {
    return 'the response looks like JSON, not a binary'
  }
  if (head.startsWith('<')) {
    return 'the response looks like HTML or XML, not a binary'
  }
  return `the response is ${bytes.length} bytes and matches no known executable format`
}

/**
 * Fails unless `bytes` is an executable built for the runner we are installing
 * on. An architecture the header does not pin down is accepted — the platform
 * selected it from the os/arch we asked for.
 */
function assertBinaryMatchesRunner(bytes: Buffer, osName: string, archName: string): void {
  const target = sniffBinaryTarget(bytes)

  if (!target) {
    throw new Error(
      `The fs-cli download for ${osName}/${archName} is not an executable: ` +
        `${describeNonBinary(bytes)}.`,
    )
  }
  if (target.os !== osName) {
    throw new Error(
      `The fs-cli download for ${osName}/${archName} is a ${target.os} binary. ` +
        `Refusing to install it on a ${osName} runner.`,
    )
  }
  if (target.arch && target.arch !== archName) {
    throw new Error(
      `The fs-cli download for ${osName}/${archName} is built for ${target.arch}. ` +
        `Refusing to install it on an ${archName} runner.`,
    )
  }
}

/**
 * Downloads fs-cli for the current runner from the platform's CLI download
 * endpoint and puts it on PATH. Returns the path to the installed binary.
 *
 * The download URL returned by the API is pre-signed, so the binary itself is
 * fetched without the auth header.
 */
export async function installFsCli(client: FsClient): Promise<string> {
  const osName = OS_NAMES[process.platform]
  const archName = ARCH_NAMES[process.arch]

  if (!osName || !archName) {
    throw new Error(
      `fs-cli is not available for this runner (${process.platform}/${process.arch}). ` +
        `Supported: linux, darwin (macOS), and windows on amd64 (x64) or arm64.`,
    )
  }

  const download = await client.getCliDownloadUrl(osName, archName)
  const { download_url: downloadUrl, version } = download

  core.info(
    `Requesting fs-cli ${version ?? 'latest'} for ${osName}/${archName} ` +
      `(runner: ${process.platform}/${process.arch})`,
  )

  const response = await fetch(downloadUrl)
  if (!response.ok) {
    throw new Error(`Failed to download fs-cli: HTTP ${response.status} from the download URL.`)
  }

  // Verify before anything is written: the platform picks the build from the
  // os/arch we asked for, and this confirms that is what arrived.
  const bytes = Buffer.from(await response.arrayBuffer())
  assertBinaryMatchesRunner(bytes, osName, archName)

  const installDir = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'fs-cli')
  await fs.mkdir(installDir, { recursive: true })

  const binary = path.join(installDir, osName === 'windows' ? 'fs-cli.exe' : 'fs-cli')
  await fs.writeFile(binary, bytes)
  await fs.chmod(binary, 0o755)

  core.addPath(installDir)
  core.info(`Installed fs-cli ${version ?? ''} (${osName}/${archName}) to ${binary}`.trim())

  return binary
}

/**
 * Returns the path to `binary` if it is executable on PATH, else undefined.
 */
async function findOnPath(binary: string): Promise<string | undefined> {
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']

  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    for (const ext of extensions) {
      const candidate = path.join(dir, `${binary}${ext}`)
      try {
        await fs.access(candidate, fsConstants.X_OK)
        return candidate
      } catch {
        // Not here — keep looking.
      }
    }
  }

  return undefined
}

/**
 * Returns a usable fs-cli, installing it only when the runner does not already
 * have one on PATH (i.e. when the setup action did not run in this job).
 */
export async function ensureFsCli(client: FsClient): Promise<string> {
  const existing = await findOnPath('fs-cli')
  if (existing) {
    core.info(`Using fs-cli already on PATH: ${existing}`)
    return existing
  }

  return installFsCli(client)
}
