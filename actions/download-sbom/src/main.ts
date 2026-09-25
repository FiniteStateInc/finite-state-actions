import * as core from '@actions/core'
import * as exec from '@actions/exec'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { dirname } from 'path'
import { DefaultArtifactClient } from '@actions/artifact'
import {
  FsClient,
  ensureFsCli,
  normalizeSbomFormat,
  quoteExecPath,
  readSetupContext,
} from '@finite-state/core'

/**
 * Counts the entries in an SBOM document written by fs-cli.
 *
 * CycloneDX calls them `components` and SPDX calls them `packages`; reading only
 * the first reported 0 for every SPDX export. The two are not quite the same
 * population either — SPDX usually includes the document's own describing
 * package, CycloneDX excludes `metadata.component` and nested
 * `components[].components` — so the count is a rough size signal, not a figure
 * to compare across formats. That caveat is documented on the output.
 *
 * A document that is present but unreadable is worth a warning, not a failed
 * step: the file is already on disk and the artifact upload still has to
 * happen. A missing or empty file is the caller's problem, not this function's,
 * and both are checked before the call — an export that produced no usable
 * bytes is a failure, not a count of zero.
 *
 * A count of 0 is reported three ways on purpose: an unparseable file warns with
 * the parse error, a document carrying neither array warns that the shape was
 * not recognised, and a genuinely empty SBOM returns 0 silently. Without the
 * middle case a shape this function does not model is indistinguishable from an
 * SBOM with no components, and `component-count` is what downstream gates read.
 */
function countComponents(contents: string, file: string): number {
  try {
    const doc = JSON.parse(contents) as {
      components?: unknown[]
      packages?: unknown[]
    }
    // Prefer whichever array actually carries entries: a merged or wrapped
    // document can hold an empty `components` beside a populated `packages`,
    // and `??` alone would report 0 for it.
    const populated = [doc.components, doc.packages].find(
      (entries) => Array.isArray(entries) && entries.length > 0,
    )
    if (Array.isArray(populated)) {
      return populated.length
    }
    if (Array.isArray(doc.components) || Array.isArray(doc.packages)) {
      return 0
    }
    core.warning(
      `${file} parsed as JSON but carries neither a CycloneDX "components" nor an SPDX ` +
        `"packages" array. Reporting 0 components; the exported file itself is unaffected.`,
      { title: 'Component count unavailable' },
    )
    return 0
  } catch (err) {
    core.warning(
      `Could not count components in ${file}: ${err instanceof Error ? err.message : String(err)}. ` +
        `If the export is not JSON this count does not apply; the file itself is unaffected.`,
      { title: 'Component count unavailable' },
    )
    return 0
  }
}

export async function run(): Promise<void> {
  try {
    // ── Read inputs ──────────────────────────────────────────────────────────
    const versionIdInput = core.getInput('version-id') || undefined
    const projectIdInput = core.getInput('project-id') || undefined
    const projectNameInput = core.getInput('project-name') || undefined
    const version = core.getInput('version') || undefined
    // Validated rather than cast, and through the same core helper `upload`
    // uses, so `cdx` and `CycloneDX` mean here what they mean there instead of
    // reaching fs-cli unmapped.
    const format = normalizeSbomFormat(core.getInput('format') || 'cyclonedx')
    const maxSize = core.getInput('max-size') || undefined
    const includeVex = core.getBooleanInput('include-vex')
    const outputFile = core.getInput('output-file') || 'sbom.json'
    const uploadArtifact = core.getBooleanInput('upload-artifact')
    const artifactName = core.getInput('artifact-name') || 'finite-state-sbom'
    const apiTokenInput = core.getInput('api-token') || undefined
    const domainInput = core.getInput('domain') || undefined

    // ── Read setup context, falling back to this action's own inputs ─────────
    // Running without the setup action is supported: pass api-token here, the
    // same way scan and upload accept it.
    // Both project inputs go in, as `scan` and `upload` do, so `ctx` is the one
    // place any later code reads the project from. The locator below still tests
    // the raw inputs first and cannot be collapsed to read `ctx` alone:
    // `readSetupContext` merges input over environment, which erases the
    // distinction the precedence rule depends on — an explicit project-name has
    // to beat an inherited project ID, and after the merge both are just set.
    const ctx = readSetupContext({
      apiToken: apiTokenInput,
      domain: domainInput,
      projectId: projectIdInput,
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
    // Either explicit project input wins over inherited context: the two can
    // name different projects, and sending both would leave fs-cli to pick. An
    // explicit project-id outranks an explicit project-name because a UUID
    // cannot be ambiguous, whereas a name can match several projects.
    const project = projectIdInput
      ? ['--project-id', projectIdInput]
      : projectNameInput
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
    //
    // Every branch that drops an input the caller set says so. The version-id
    // branch is the one that most needs it: a mistaken version-id exports a
    // different version entirely while the project and label inputs sitting
    // beside it look like they applied.
    const locator: string[] = []
    if (versionIdInput) {
      const shadowed = [
        projectIdInput && 'project-id',
        projectNameInput && 'project-name',
        version && 'version',
      ].filter((name): name is string => Boolean(name))
      if (shadowed.length) {
        core.warning(
          `version-id ${versionIdInput} locates the version on its own, so ` +
            `${shadowed.join(', ')} ${shadowed.length > 1 ? 'were' : 'was'} not used. Remove ` +
            `version-id to export by ${shadowed.includes('version') ? 'label' : 'project'} instead.`,
          { title: 'Locator inputs ignored' },
        )
      }
      locator.push('--version-id', versionIdInput)
    } else if (version) {
      // A label needs a project to resolve against, and falling through to the
      // inherited ID when there is none would export the upstream scan's
      // version while the workflow asked for a label — the silent override this
      // precedence exists to prevent. Missing project, missing export.
      if (!project.length) {
        throw new Error(
          `version "${version}" needs a project to resolve against. Pass project-id or ` +
            'project-name, or run setup, scan or upload first so a project is inherited, or ' +
            'pass version-id instead.',
        )
      }
      locator.push(...project, '--version', version)
    } else if (ctx.versionId) {
      // A project input with no version to go with it cannot form a label
      // locator, so the inherited version ID is used instead — but that ID
      // carries its own project, which may not be the one just named. Say so
      // rather than dropping the input silently.
      const given = [projectIdInput && 'project-id', projectNameInput && 'project-name'].filter(
        (name): name is string => Boolean(name),
      )
      if (given.length) {
        core.warning(
          `${given.join(' and ')} ${given.length > 1 ? 'were' : 'was'} given without version, ` +
            `so ${given.length > 1 ? 'they' : 'it'} cannot locate a version. Exporting the ` +
            `inherited version ID ${ctx.versionId} instead, which may belong to a different ` +
            `project. Pass version to export by label, or version-id to be explicit.`,
          { title: 'Project input ignored' },
        )
      }
      locator.push('--version-id', ctx.versionId)
    } else {
      throw new Error(
        'No project version to export. Provide version-id, or version together with ' +
          'project-id or project-name, or run scan or upload first — both export a version ID ' +
          'this action inherits. setup alone only supplies one when it was given version-id ' +
          'itself.',
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
    //
    // `--max-size` is passed only when the `max-size` input is set. fs-cli caps
    // the response at 64 MiB by default, which the REST path this replaced did
    // not do, so a version whose SBOM exceeds that now needs the input raised —
    // the reason it exists rather than being left to an unstated default.
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
        ...(maxSize ? ['--max-size', maxSize] : []),
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

    // An exit-0 export that produced no usable bytes is a failure, not a
    // warning. Left to countComponents it would surface as "component count
    // unavailable" plus `component-count: 0` — which a gate reads as a clean
    // SBOM — and then, only if upload-artifact is on, an opaque artifact error
    // naming no cause. A zero-byte file is the same failure as a missing one:
    // it clears `existsSync` but there is no SBOM in it.
    if (!existsSync(outputFile)) {
      throw new Error(
        `fs-cli export reported success but wrote no file at ${outputFile}. ` +
          'Check output-file and the fs-cli output above.',
      )
    }

    // Read once, then count from the contents: a second read purely to count
    // would load the document twice.
    const contents = readFileSync(outputFile, 'utf8')
    if (!contents.trim()) {
      throw new Error(
        `fs-cli export reported success but wrote an empty file at ${outputFile}. ` +
          'See the fs-cli output above.',
      )
    }

    core.info(`SBOM written to ${outputFile}`)

    // ── Set outputs ──────────────────────────────────────────────────────────
    const componentCount = countComponents(contents, outputFile)

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
