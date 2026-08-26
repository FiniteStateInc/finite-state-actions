import type {
  AuthUser,
  CreateProjectOptions,
  Project,
  Version,
  Scan,
  ScanType,
  SbomFormat,
} from './models'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FsClientConfig {
  apiToken: string
  domain: string
}

export interface CliDownload {
  download_url: string
  /** Latest fs-cli version for the requested platform, e.g. `v2.3.30`. */
  version?: string
  release_date?: string
}

export interface UploadScanOptions {
  type: ScanType
  filename: string
  projectVersionId: string
  data: Uint8Array | Buffer
  /** Required when type is 'sbom' */
  sbomFormat?: SbomFormat
  /** Required when type is 'third-party' */
  scannerType?: string
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_RETRIES = 6
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504])
const NON_RETRYABLE_STATUSES = new Set([400, 401, 403, 404, 500])

// ── FsClient ──────────────────────────────────────────────────────────────────

export class FsClient {
  private readonly baseUrl: string
  private readonly headers: Record<string, string>

  constructor(config: FsClientConfig) {
    this.baseUrl = `https://${config.domain}/api/public/v0`
    this.headers = {
      'X-Authorization': config.apiToken,
      'Content-Type': 'application/json',
    }
  }

  // ── Internal request helpers ───────────────────────────────────────────────

  private async request<T>(url: string, opts: RequestInit): Promise<T> {
    let attempt = 0

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const response = await fetch(url, opts)

      if (response.ok) {
        return response.json() as Promise<T>
      }

      const status = response.status

      if (NON_RETRYABLE_STATUSES.has(status)) {
        const body = await response.text().catch(() => '')
        if (status === 401) {
          throw new Error(
            `Unauthorized (401): Invalid or missing API token. ` +
              `Check your X-Authorization header. Response: ${body}`,
          )
        }
        throw new Error(`HTTP ${status} error from ${url}: ${body}`)
      }

      if (RETRYABLE_STATUSES.has(status) && attempt < MAX_RETRIES) {
        const backoffMs = Math.pow(2, attempt) * 500
        await sleep(backoffMs)
        attempt++
        continue
      }

      // Exhausted retries or unknown status
      const body = await response.text().catch(() => '')
      throw new Error(`HTTP ${status} error after ${attempt} retries from ${url}: ${body}`)
    }
  }

  private get<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`
    return this.request<T>(url, {
      method: 'GET',
      headers: this.headers,
    })
  }

  private post<T>(path: string, body: unknown, contentType?: string): Promise<T> {
    const url = `${this.baseUrl}${path}`
    const headers: Record<string, string> = {
      ...this.headers,
    }
    if (contentType) {
      headers['Content-Type'] = contentType
    }
    const init: RequestInit =
      body instanceof Uint8Array || Buffer.isBuffer(body as Buffer)
        ? { method: 'POST', headers, body: body as BodyInit }
        : { method: 'POST', headers, body: JSON.stringify(body) }
    return this.request<T>(url, init)
  }

  // ── Public API methods ─────────────────────────────────────────────────────

  /**
   * GET /authUser — returns the currently authenticated user.
   */
  getAuthUser(): Promise<AuthUser> {
    return this.get<AuthUser>('/authUser')
  }

  /**
   * GET /cli/download — returns a short-lived, pre-signed URL for the fs-cli
   * binary matching the given platform. `os` is one of linux|darwin|windows,
   * `arch` one of amd64|arm64.
   */
  getCliDownloadUrl(os: string, arch: string): Promise<CliDownload> {
    const params = new URLSearchParams({ os, arch })
    return this.get<CliDownload>(`/cli/download?${params.toString()}`)
  }

  /**
   * GET /projects — list projects, optionally filtering by name.
   */
  async listProjects(name?: string): Promise<Project[]> {
    const params = new URLSearchParams()
    if (name) {
      params.set('filter', `name==${name}`)
    }
    const query = params.toString()
    const path = query ? `/projects?${query}` : '/projects'
    const raw = await this.get<Project[] | { projects: Project[] }>(path)
    return Array.isArray(raw) ? raw : raw.projects
  }

  /**
   * POST /projects — creates a project. The platform rejects an empty
   * description, so it falls back to the project name.
   */
  createProject(name: string, opts: CreateProjectOptions = {}): Promise<Project> {
    const body: Record<string, unknown> = {
      name,
      type: (opts.projectType || 'firmware').toLowerCase(),
      description: opts.description || name,
    }
    if (opts.folderId) {
      body.folderId = opts.folderId
    }
    return this.post<Project>('/projects', body)
  }

  /**
   * POST /projects/{projectId}/versions — creates a new version.
   */
  createVersion(projectId: string, versionName: string, releaseType = 'RELEASE'): Promise<Version> {
    return this.post<Version>(`/projects/${projectId}/versions`, {
      version: versionName,
      releaseType,
    })
  }

  /**
   * Upload a scan file. Routes to different endpoints based on scan type.
   * Returns { id } of the created scan resource.
   */
  async uploadScan(opts: UploadScanOptions): Promise<{ id: string }> {
    const { type, filename, projectVersionId, data } = opts
    const base = `filename=${encodeURIComponent(filename)}&projectVersionId=${encodeURIComponent(projectVersionId)}`

    let path: string

    switch (type) {
      case 'sbom': {
        const fmt = opts.sbomFormat ?? 'cyclonedx'
        path = `/scans/sbom?type=${encodeURIComponent(fmt)}&${base}`
        break
      }
      case 'third-party': {
        const scanner = opts.scannerType ?? ''
        path = `/scans/third-party?type=${encodeURIComponent(scanner)}&${base}`
        break
      }
      case 'vulnerability-analysis': {
        path = `/scans?type=vulnerability_analysis&${base}`
        break
      }
      default: {
        // sca | sast | config
        path = `/scans?type=${encodeURIComponent(type)}&${base}`
        break
      }
    }

    return this.post<{ id: string }>(path, data, 'application/octet-stream')
  }

  /**
   * GET /scans with filter for a project version — returns the latest scan.
   */
  async getScanStatus(projectVersionId: string): Promise<Scan> {
    const params = new URLSearchParams({
      filter: `projectVersion==${projectVersionId}`,
      sort: 'created:desc',
      limit: '1',
    })
    const raw = await this.get<Scan[] | { scans: Scan[] }>(`/scans?${params.toString()}`)

    const scans = Array.isArray(raw) ? raw : raw.scans
    if (!scans || scans.length === 0) {
      throw new Error(`No scans found for projectVersionId=${projectVersionId}`)
    }
    return scans[0]
  }

  /**
   * GET /sboms/{format}/{pvId}?includeVex={bool}
   */
  downloadSbom(pvId: string, format: SbomFormat, includeVex: boolean): Promise<object> {
    return this.get<object>(
      `/sboms/${encodeURIComponent(format)}/${encodeURIComponent(pvId)}?includeVex=${includeVex}`,
    )
  }

  /**
   * Polls getScanStatus until the scan reaches COMPLETED or FAILED, or until
   * timeoutMs elapses.
   */
  async pollScanCompletion(
    projectVersionId: string,
    timeoutMs: number,
    intervalMs: number,
  ): Promise<Scan> {
    const deadline = Date.now() + timeoutMs

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const scan = await this.getScanStatus(projectVersionId)

      if (scan.status === 'COMPLETED') {
        return scan
      }

      if (scan.status === 'FAILED' || scan.status === 'CANCELLED') {
        throw new Error(`Scan ${scan.id} reached terminal status: ${scan.status}`)
      }

      if (Date.now() + intervalMs > deadline) {
        throw new Error(
          `Scan polling timeout after ${timeoutMs}ms for projectVersionId=${projectVersionId}`,
        )
      }

      await sleep(intervalMs)
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns a display-able identity from an /authUser response, probing the
 * canonical `user` field first. Undefined when the shape is unrecognized.
 */
export function authUserIdentity(authUser: AuthUser): string | undefined {
  return authUser.user || authUser.email || authUser.username || authUser.id || undefined
}

/**
 * Returns a display-able organization label, or undefined when absent.
 */
export function authUserOrganization(authUser: AuthUser): string | undefined {
  return authUser.organization?.name || authUser.organization?.id || undefined
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Returns true when the value looks like a UUID (the expected project ID format).
 */
export function isProjectId(value: string): boolean {
  return UUID_RE.test(value)
}

/**
 * Thrown when a project name matches no project. Callers that can proceed
 * without an ID (letting fs-cli create the project) catch this specifically.
 */
export class ProjectNotFoundError extends Error {
  constructor(public readonly projectName: string) {
    super(
      `No project found with name "${projectName}". Pass a valid project ID or an exact project name.`,
    )
    this.name = 'ProjectNotFoundError'
  }
}

/**
 * If `value` is already a UUID, returns it as-is. Otherwise treats it as a
 * project name, queries the API, and returns the matching project ID.
 * Throws when the name matches zero or more than one project.
 */
export async function resolveProjectId(client: FsClient, value: string): Promise<string> {
  if (isProjectId(value)) {
    return value
  }

  const projects = await client.listProjects(value)

  if (projects.length === 0) {
    throw new ProjectNotFoundError(value)
  }

  if (projects.length > 1) {
    const names = projects.map((p) => `${p.name} (${p.id})`).join(', ')
    throw new Error(
      `Multiple projects match name "${value}": ${names}. Pass the project ID (UUID) to be unambiguous.`,
    )
  }

  return projects[0].id
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
