import * as core from '@actions/core'
import { mkdirSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { DefaultArtifactClient } from '@actions/artifact'
import { FsClient, readSetupContext } from '@finite-state/core'
import type { SbomFormat } from '@finite-state/core'

export async function run(): Promise<void> {
  try {
    // ── Read inputs ──────────────────────────────────────────────────────────
    const versionIdInput = core.getInput('version-id') || undefined
    const format = (core.getInput('format') || 'cyclonedx') as SbomFormat
    const includeVex = core.getBooleanInput('include-vex')
    const outputFile = core.getInput('output-file') || 'sbom.json'
    const uploadArtifact = core.getBooleanInput('upload-artifact')
    const artifactName = core.getInput('artifact-name') || 'finite-state-sbom'

    // ── Read setup context with version-id override ──────────────────────────
    const ctx = readSetupContext({ versionId: versionIdInput })

    // ── Validate version ID ──────────────────────────────────────────────────
    if (!ctx.versionId) {
      throw new Error(
        'version-id is required. Provide it as an input or run finite-state/setup first.',
      )
    }

    const versionId = ctx.versionId

    // ── Build client & download SBOM ─────────────────────────────────────────
    const client = new FsClient({ apiToken: ctx.apiToken, domain: ctx.domain })

    core.info(`Downloading ${format} SBOM for version ${versionId} (includeVex=${includeVex})...`)
    const sbom = await client.downloadSbom(versionId, format, includeVex) as { components?: unknown[] }

    // ── Write SBOM to file ───────────────────────────────────────────────────
    const outputDir = dirname(outputFile)
    if (outputDir && outputDir !== '.') {
      mkdirSync(outputDir, { recursive: true })
    }
    writeFileSync(outputFile, JSON.stringify(sbom, null, 2))
    core.info(`SBOM written to ${outputFile}`)

    // ── Count components ─────────────────────────────────────────────────────
    const componentCount = Array.isArray(sbom.components) ? sbom.components.length : 0

    // ── Set outputs ──────────────────────────────────────────────────────────
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
