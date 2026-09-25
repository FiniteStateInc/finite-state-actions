import * as core from '@actions/core'
import * as exec from '@actions/exec'
import { mkdirSync, readFileSync } from 'fs'
import { dirname } from 'path'
import { DefaultArtifactClient } from '@actions/artifact'
import { FsClient, ensureFsCli, quoteExecPath, readSetupContext } from '@finite-state/core'
import type { SbomFormat } from '@finite-state/core'

/**
 * Counts the entries in an SBOM document written by fs-cli.
 *
 * CycloneDX calls them `components`, SPDX calls them `packages` — reading only
 * the first reported 0 for every SPDX export. A document that cannot be read or
 * parsed is worth a warning, not a failed step: the file is already on disk and
 * the artifact upload still has to happen.
 *
 * Reading the whole file to count is bounded by fs-cli itself, whose
 * `--max-size` rejects an SBOM over 64 MiB before it ever reaches disk.
 *
 * A count of 0 is reported three ways on purpose: an unreadable file warns with
 * the parse error, a document carrying neither array warns that the shape was
 * not recognised, and a genuinely empty SBOM returns 0 silently. Without the
 * middle case a shape this function does not model is indistinguishable from an
 * SBOM with no components, and `component-count` is what downstream gates read.
 */
function countComponents(file: string): number {
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8')) as {
      components?: unknown[]
      packages?: unknown[]
    }
    const entries = doc.components ?? doc.packages
    if (!Array.isArray(entries)) {
      core.warning(
        `${file} parsed as JSON but carries neither a CycloneDX "components" nor an SPDX ` +
          `"packages" array. Reporting 0 components; the exported file itself is unaffected.`,
        { title: 'Component count unavailable' },
      )
      return 0
    }
    return entries.length
  } catch (err) {
    core.warning(
      `Could not count components in ${file}: ${err instanceof Error ? err.message : String(err)}`,
      { title: 'Component count unavailable' },
    )
    return 0
  }
}

export async function run(): Promise<void> {
  try {
    // ── Read inputs ──────────────────────────────────────────────────────────
    const versionIdInput = core.getInput('version-id') || undefined
    const projectNameInput = core.getInput('project-name') || undefined
    const version = core.getInput('version') || undefined
    const format = (core.getInput('format') || 'cyclonedx') as SbomFormat
    const includeVex = core.getBooleanInput('include-vex')
    const outputFile = core.getInput('output-file') || 'sbom.json'
    const uploadArtifact = core.getBooleanInput('upload-artifact')
    const artifactName = core.getInput('artifact-name') || 'finite-state-sbom'
    const apiTokenInput = core.getInput('api-token') || undefined
    const domainInput = core.getInput('domain') || undefined

    // ── Read setup context, falling back to this action's own inputs ─────────
    // Running without the setup action is supported: pass api-token here, the
    // same way scan and upload accept it.
    const ctx = readSetupContext({
      apiToken: apiTokenInput,
      domain: domainInput,
      projectName: projectNameInput,
      versionId: versionIdInput,
    })

    // Mask the token when it came from this action's input rather than setup.
    core.setSecret(ctx.apiToken)

    // ── Resolve the project version ──────────────────────────────────────────
    // fs-cli takes either the version UUID directly or a name/version pair it
    // resolves itself. A version ID skips both lookups, so prefer it when an
    // upstream scan or upload exported one.
    //
    // An explicit project-name input wins over an inherited project ID: the two
    // can name different projects, and sending both would leave fs-cli to pick.
    const project = projectNameInput
      ? ['--name', projectNameInput]
      : ctx.projectId
        ? ['--project-id', ctx.projectId]
        : ctx.projectName
          ? ['--name', ctx.projectName]
          : []

    // Explicit inputs beat inherited context, the same rule the project
    // resolution above follows. An explicit version-id is the most specific
    // locator there is; failing that, a version label typed into this step is
    // an instruction to export something other than whatever an upstream scan
    // left in the environment, so it outranks the inherited ID. Only with
    // neither input does the inherited version ID apply — which is what makes
    // `scan` → `download-sbom` with no inputs work.
    const locator: string[] = []
    if (versionIdInput) {
      locator.push('--version-id', versionIdInput)
    } else if (version) {
      // A label needs a project to resolve against, and falling through to the
      // inherited ID when there is none would export the upstream scan's
      // version while the workflow asked for a label — the silent override this
      // precedence exists to prevent. Missing project, missing export.
      if (!project.length) {
        throw new Error(
          `version "${version}" needs a project to resolve against. Pass project-name, or run ` +
            'setup, scan or upload first so a project is inherited, or pass version-id instead.',
        )
      }
      locator.push(...project, '--version', version)
    } else if (ctx.versionId) {
      locator.push('--version-id', ctx.versionId)
    } else {
      throw new Error(
        'No project version to export. Provide version-id, or project-name and version, or ' +
          'run scan or upload first — both export a version ID this action inherits. ' +
          'setup alone only supplies one when it was given version-id itself.',
      )
    }

    // ── Install or reuse fs-cli ──────────────────────────────────────────────
    // Reuses an fs-cli that an earlier Finite State step put on PATH and
    // downloads one only when this is the first such step in the job.
    const fsCli = await ensureFsCli(new FsClient({ apiToken: ctx.apiToken, domain: ctx.domain }))

    // ── Export the SBOM ──────────────────────────────────────────────────────
    // fs-cli writes the document byte for byte, so the file keeps whatever
    // formatting and signing the platform applied.
    //
    // The output directory is ours to create: fs-cli writes the file, not the
    // path leading to it. --overwrite because a re-run in the same job would
    // otherwise fail on the file the first run left behind.
    //
    // The token goes through FS_TOKEN so it stays out of the argument list, and
    // the path is quoted because exec splits its first parameter on spaces.
    //
    // The argv below matches `fs-cli export --help`: `--endpoint`, `--format`
    // (cyclonedx | spdx), `--include-vex` as a `=<bool>` switch defaulting to
    // true, `--output-file`, `--overwrite`, and the four locator flags
    // `--name`/`--project-id`/`--version`/`--version-id`. Unlike `upload`,
    // `export` does not require `--name` alongside `--project-id` — its help is
    // explicit that `--project-id` and `--version-id` are there to skip the name
    // lookups — so the `--project-id` branch deliberately sends the ID alone.
    // fs-cli also caps the response at `--max-size` (64 MiB by default), which
    // is the bound countComponents relies on.
    const outputDir = dirname(outputFile)
    if (outputDir && outputDir !== '.') {
      mkdirSync(outputDir, { recursive: true })
    }

    core.info(`Exporting ${format} SBOM to ${outputFile} (includeVex=${includeVex})...`)

    const exitCode = await exec.exec(
      quoteExecPath(fsCli),
      [
        'export',
        '--endpoint',
        `https://${ctx.domain}`,
        ...locator,
        '--format',
        format,
        `--include-vex=${includeVex}`,
        '--output-file',
        outputFile,
        '--overwrite',
      ],
      {
        ignoreReturnCode: true,
        env: { ...process.env, FS_TOKEN: ctx.apiToken } as Record<string, string>,
      },
    )

    if (exitCode !== 0) {
      // fs-cli has already printed why; this adds the context a bare non-zero
      // exit does not carry.
      throw new Error(
        `fs-cli export exited ${exitCode} on ${ctx.domain}. See the fs-cli output above.`,
      )
    }

    core.info(`SBOM written to ${outputFile}`)

    // ── Set outputs ──────────────────────────────────────────────────────────
    const componentCount = countComponents(outputFile)

    core.setOutput('file', outputFile)
    core.setOutput('component-count', String(componentCount))
    core.setOutput('artifact-name', artifactName)

    core.info(`SBOM contains ${componentCount} component(s)`)

    // ── Upload artifact ──────────────────────────────────────────────────────
    if (uploadArtifact) {
      const artifactClient = new DefaultArtifactClient()
      await artifactClient.uploadArtifact(artifactName, [outputFile], outputDir || '.')
      core.info(`Uploaded SBOM as artifact: ${artifactName}`)
    }
  } catch (err) {
    core.setFailed(err instanceof Error ? err.message : String(err))
  }
}

run()
