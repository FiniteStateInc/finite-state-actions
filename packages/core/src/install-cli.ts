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
        `Supported: linux, darwin, windows on amd64 or arm64.`,
    )
  }

  const { download_url: downloadUrl } = await client.getCliDownloadUrl(osName, archName)

  const response = await fetch(downloadUrl)
  if (!response.ok) {
    throw new Error(`Failed to download fs-cli: HTTP ${response.status} from the download URL.`)
  }

  const installDir = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'fs-cli')
  await fs.mkdir(installDir, { recursive: true })

  const binary = path.join(installDir, process.platform === 'win32' ? 'fs-cli.exe' : 'fs-cli')
  await fs.writeFile(binary, Buffer.from(await response.arrayBuffer()))
  await fs.chmod(binary, 0o755)

  core.addPath(installDir)
  core.info(`Installed fs-cli (${osName}/${archName}) to ${binary}`)

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
