import * as core from '@actions/core'
import * as exec from '@actions/exec'
import { readdirSync, statSync } from 'fs'
import { join } from 'path'
import { DefaultArtifactClient } from '@actions/artifact'
import { readSetupContext, parseReportDirectory } from '@finite-state/core'

// ── Helpers ────────────────────────────────────────────────────────────────────

function collectFiles(dir: string): string[] {
  const results: string[] = []
  try {
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry)
      if (statSync(fullPath).isDirectory()) {
        results.push(...collectFiles(fullPath))
      } else {
        results.push(fullPath)
      }
    }
  } catch {
    // Directory may not exist if no reports were produced
  }
  return results
}

// ── Main ───────────────────────────────────────────────────────────────────────

export async function run(): Promise<void> {
  try {
    // ── Read inputs ──────────────────────────────────────────────────────────
    const recipe = core.getInput('recipe', { required: true })
    const projectIdOverride = core.getInput('project-id') || undefined
    const versionIdOverride = core.getInput('version-id') || undefined
    const baselineVersion = core.getInput('baseline-version') || undefined
    const currentVersion = core.getInput('current-version') || undefined
    const period = core.getInput('period') || undefined
    const cve = core.getInput('cve') || undefined
    const findingTypes = core.getInput('finding-types') || undefined
    const openOnly = core.getBooleanInput('open-only')
    const scoringFile = core.getInput('scoring-file') || undefined
    const ai = core.getBooleanInput('ai')
    const aiPrompts = core.getBooleanInput('ai-prompts')
    const outputDir = core.getInput('output-dir') || './fs-reports'
    const fsReportVersion = core.getInput('fs-report-version') || undefined
    const cacheTtl = core.getInput('cache-ttl') || '1'
    const extraArgs = core.getInput('extra-args') || undefined

    // ── Read setup context with overrides ────────────────────────────────────
    const ctx = readSetupContext({ projectId: projectIdOverride, versionId: versionIdOverride })

    // ── Install fs-report via pipx ───────────────────────────────────────────
    const pipxInstallArgs = ['install', 'fs-report', '--force']
    if (fsReportVersion) {
      pipxInstallArgs[1] = `fs-report${fsReportVersion}`
    }

    core.info('Installing fs-report via pipx...')
    await exec.exec('pipx', pipxInstallArgs, {
      env: Object.fromEntries(
        Object.entries(process.env).filter(([, v]) => v !== undefined),
      ) as Record<string, string>,
    })

    // ── Build fs-report args ─────────────────────────────────────────────────
    const args: string[] = ['run', '--headless', '--output', outputDir, '--cache-ttl', cacheTtl]

    // Split recipes by comma, add each as --recipe "Name"
    const recipes = recipe
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean)
    for (const r of recipes) {
      args.push('--recipe', r)
    }

    // Add project/version from context
    if (ctx.projectId) {
      args.push('--project-id', ctx.projectId)
    }
    if (ctx.versionId) {
      args.push('--version-id', ctx.versionId)
    }

    // Optional flags
    if (period) {
      args.push('--period', period)
    }
    if (cve) {
      args.push('--cve', cve)
    }
    if (findingTypes) {
      args.push('--finding-types', findingTypes)
    }
    if (openOnly) {
      args.push('--open-only')
    }
    if (scoringFile) {
      args.push('--scoring-file', scoringFile)
    }
    if (ai) {
      args.push('--ai')
    }
    if (aiPrompts) {
      args.push('--ai-prompts')
    }
    if (baselineVersion) {
      args.push('--baseline-version', baselineVersion)
    }
    if (currentVersion) {
      args.push('--current-version', currentVersion)
    }

    // Split extra-args by whitespace and append
    if (extraArgs) {
      const extra = extraArgs.split(/\s+/).filter(Boolean)
      args.push(...extra)
    }

    // ── Run fs-report ────────────────────────────────────────────────────────
    core.info(`Running fs-report with ${recipes.length} recipe(s): ${recipes.join(', ')}`)
    const baseEnv = Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined),
    ) as Record<string, string>
    await exec.exec('fs-report', args, {
      env: {
        ...baseEnv,
        FINITE_STATE_AUTH_TOKEN: ctx.apiToken,
        FINITE_STATE_DOMAIN: ctx.domain,
      },
    })

    // ── Parse report directory ───────────────────────────────────────────────
    const summary = parseReportDirectory(outputDir)

    // ── Set outputs ──────────────────────────────────────────────────────────
    core.setOutput('report-dir', outputDir)
    core.setOutput('summary-json', JSON.stringify(summary))
    core.setOutput('critical-count', String(summary.triageBands?.P0 ?? 0))
    core.setOutput('high-count', String(summary.triageBands?.P1 ?? 0))
    core.setOutput('new-findings', String(summary.versionDelta?.newFindings.length ?? 0))
    core.setOutput('fixed-findings', String(summary.versionDelta?.fixedFindings.length ?? 0))

    // ── Upload artifact ──────────────────────────────────────────────────────
    const artifactName = `fs-report-${Date.now()}`
    const files = collectFiles(outputDir)

    if (files.length > 0) {
      const artifactClient = new DefaultArtifactClient()
      await artifactClient.uploadArtifact(artifactName, files, outputDir)
      core.info(`Uploaded ${files.length} report file(s) as artifact: ${artifactName}`)
    } else {
      core.warning(`No report files found in ${outputDir} to upload as artifact`)
    }

    core.setOutput('artifact-name', artifactName)

    core.info(`Report complete. Summary: ${JSON.stringify(summary.severityCounts)}`)
  } catch (err) {
    core.setFailed(err instanceof Error ? err.message : String(err))
  }
}

run()
