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

  // Mach-O. A thin binary's magic is MH_MAGIC_64 (0xfeedfacf) in the file's own
  // byte order, so a native little-endian build reads 0xcffaedfe big-endian —
  // that is the arm64/x86_64 case, and its cputype is little-endian at offset 4.
  // The byte-swapped magics are the same header written big-endian, so read
  // cputype big-endian there rather than giving up on the architecture.
  if (bytes.length > 8) {
    const magic = bytes.readUInt32BE(0)
    if (magic === 0xcffaedfe || magic === 0xcefaedfe) {
      return { os: 'darwin', arch: MACHO_CPUS[bytes.readUInt32LE(4)] }
    }
    if (magic === 0xfeedfacf || magic === 0xfeedface) {
      return { os: 'darwin', arch: MACHO_CPUS[bytes.readUInt32BE(4)] }
    }
    // A universal ("fat") binary carries several architectures, so there is no
    // single value to check — the OS is still certain.
    if (magic === 0xcafebabe || magic === 0xbebafeca) {
      return { os: 'darwin' }
    }
  }

  // PE: 'MZ', then the PE header offset as a little-endian u32 at 0x3c. A file
  // with the DOS stub but no PE signature is truncated or not an executable, so
  // it is rejected rather than accepted with an unchecked architecture.
  if (bytes.length > 0x40 && bytes[0] === 0x4d && bytes[1] === 0x5a) {
    const peOffset = bytes.readUInt32LE(0x3c)
    if (
      bytes.length > peOffset + 6 &&
      bytes.subarray(peOffset, peOffset + 4).equals(Buffer.from([0x50, 0x45, 0x00, 0x00]))
    ) {
      return { os: 'windows', arch: PE_MACHINES[bytes.readUInt16LE(peOffset + 4)] }
    }
    return undefined
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
 * Returns the reason `bytes` is not an executable built for `osName`/`archName`,
 * or undefined when it is. Only a universal Mach-O is allowed to leave the
 * architecture unverified, since it carries several; every other header either
 * names an architecture we recognise or is rejected.
 */
function binaryMismatchReason(bytes: Buffer, osName: string, archName: string): string | undefined {
  const target = sniffBinaryTarget(bytes)

  if (!target) {
    return `it is not an executable: ${describeNonBinary(bytes)}`
  }
  if (target.os !== osName) {
    return `it is a ${target.os} binary, not ${osName}`
  }
  if (target.arch === undefined) {
    // Only the fat Mach-O path reaches here; anything else means a machine
    // value we do not know, which is exactly the mismatch worth catching.
    if (target.os === 'darwin' && bytes.length > 4) {
      const magic = bytes.readUInt32BE(0)
      if (magic === 0xcafebabe || magic === 0xbebafeca) {
        return undefined
      }
    }
    return `its header names an architecture this action does not recognise, so it cannot be confirmed as ${archName}`
  }
  if (target.arch !== archName) {
    return `it is built for ${target.arch}, not ${archName}`
  }

  return undefined
}

/**
 * Fails unless `bytes` is an executable built for the runner we are installing on.
 */
function assertBinaryMatchesRunner(bytes: Buffer, osName: string, archName: string): void {
  const reason = binaryMismatchReason(bytes, osName, archName)
  if (reason) {
    throw new Error(
      `The fs-cli download for ${osName}/${archName} cannot be installed on this ` +
        `${osName}/${archName} runner: ${reason}.`,
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

  if (!downloadUrl) {
    throw new Error(`The platform returned no download URL for fs-cli on ${osName}/${archName}.`)
  }

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
 * Reads enough of a file's head to identify its executable format. 8 KB covers
 * the ELF and Mach-O headers outright and every realistic PE header offset.
 */
async function readHeader(file: string): Promise<Buffer> {
  const handle = await fs.open(file, 'r')
  try {
    const buffer = Buffer.alloc(8192)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
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
    // An fs-cli on PATH is normally the one `setup` installed, but it can also
    // be a stale or foreign binary — check it against this runner rather than
    // trusting the name, and download a correct one when it does not match.
    const reason = await inspectExistingFsCli(existing)
    if (!reason) {
      core.info(`Using fs-cli already on PATH: ${existing}`)
      return existing
    }
    core.warning(
      `Ignoring the fs-cli on PATH at ${existing}: ${reason}. Downloading one for this runner.`,
    )
  }

  return installFsCli(client)
}

/**
 * Returns why the fs-cli at `file` is unusable on this runner, or undefined when
 * it looks right. An unreadable file is reported rather than thrown, so a bad
 * PATH entry falls back to a download instead of failing the step.
 */
async function inspectExistingFsCli(file: string): Promise<string | undefined> {
  const osName = OS_NAMES[process.platform]
  const archName = ARCH_NAMES[process.arch]
  if (!osName || !archName) {
    // installFsCli reports the unsupported runner with a better message.
    return undefined
  }

  try {
    return binaryMismatchReason(await readHeader(file), osName, archName)
  } catch (err) {
    return `it could not be read (${err instanceof Error ? err.message : String(err)})`
  }
}
