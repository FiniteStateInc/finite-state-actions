---
name: fs-github-actions
description: Finite State GitHub Actions suite — action catalog, chaining patterns, workflow recipes, troubleshooting, and onboarding for AI-assisted CI/CD security workflows
globs:
  - '.github/workflows/**/*.yml'
  - '.github/workflows/**/*.yaml'
  - '**/action.yml'
  - '**/finite-state*.yml'
  - '**/fs-scoring*.yaml'
---

# Finite State GitHub Actions Suite

A modular suite of GitHub Actions for the Finite State platform, published to the GitHub Marketplace as `finite-state/*`. Enables firmware/software security scanning, vulnerability gating, PR reporting, and SBOM export in CI/CD pipelines.

**Repo:** `FiniteStateInc/finite-state-actions`
**Customer resources:** `customer-resources/02-ci-cd-automation/github-actions/`

---

## Action Catalog

### setup

Establishes authentication and configuration context for all downstream actions in the same job.

**Usage:** `finite-state/setup@v1`

**Inputs:**

| Input        | Required | Default              | Description                                               |
| ------------ | -------- | -------------------- | --------------------------------------------------------- |
| `api-token`  | yes      | —                    | FS API token (store in `secrets.FINITE_STATE_AUTH_TOKEN`) |
| `domain`     | no       | `app.finitestate.io` | Platform domain                                           |
| `project-id` | no       | —                    | Default project ID for subsequent actions                 |
| `version-id` | no       | —                    | Default version ID for subsequent actions                 |

**Outputs:**

| Output       | Description                          |
| ------------ | ------------------------------------ |
| `org-name`   | Organization name from auth response |
| `user`       | Authenticated username               |
| `project-id` | Echoed or resolved project ID        |
| `version-id` | Echoed or resolved version ID        |

**Behavior:** Validates the token via `GET /public/v0/authUser`. Exports `FINITE_STATE_AUTH_TOKEN` and `FINITE_STATE_DOMAIN` as environment variables so downstream actions inherit auth without re-specifying. Fails fast with a clear error if auth is invalid.

**Example:**

```yaml
- uses: finite-state/setup@v1
  id: fs
  with:
    api-token: ${{ secrets.FINITE_STATE_AUTH_TOKEN }}
    domain: ${{ vars.FINITE_STATE_DOMAIN }}
    project-id: ${{ vars.FINITE_STATE_PROJECT_ID }}
```

---

### upload-scan

Uploads a binary, SBOM, or third-party scan results for analysis. Handles all upload types through a single action with a `type` input.

**Usage:** `finite-state/upload-scan@v1`

**Inputs:**

| Input                 | Required | Default    | Description                                                              |
| --------------------- | -------- | ---------- | ------------------------------------------------------------------------ |
| `type`                | yes      | —          | `sca`, `sast`, `config`, `vulnerability-analysis`, `sbom`, `third-party` |
| `file`                | yes      | —          | Path to the file to upload                                               |
| `project-id`          | no       | from setup | Override project (falls back to setup context)                           |
| `version`             | no       | —          | Version name — creates a new version if provided                         |
| `version-id`          | no       | —          | Existing version ID (mutually exclusive with `version`)                  |
| `scanner-type`        | no       | —          | Required for `third-party` — e.g., `grype`, `trivy`, `snyk`              |
| `sbom-format`         | no       | —          | Required for `sbom` — `cdx` or `spdx`                                    |
| `wait-for-completion` | no       | `true`     | Poll scan status until done                                              |
| `timeout`             | no       | `600`      | Max wait time in seconds                                                 |

**Upload type routing:**

| Type                     | Endpoint                  | Use case                                            |
| ------------------------ | ------------------------- | --------------------------------------------------- |
| `sca`                    | `POST /scans`             | Binary SCA scan                                     |
| `sast`                   | `POST /scans`             | Static analysis                                     |
| `config`                 | `POST /scans`             | Configuration audit                                 |
| `vulnerability-analysis` | `POST /scans`             | Reachability analysis                               |
| `sbom`                   | `POST /scans/sbom`        | CycloneDX/SPDX import                               |
| `third-party`            | `POST /scans/third-party` | External scanner results (Grype, Trivy, Snyk, etc.) |

**Outputs:**

| Output        | Description                                 |
| ------------- | ------------------------------------------- |
| `scan-id`     | The created scan ID                         |
| `version-id`  | The version ID (created or existing)        |
| `scan-status` | Final scan status (`COMPLETED` or `FAILED`) |

**Behavior:** Resolves project/version from inputs or setup context. If `version` name is provided, creates a new version via `POST /projects/{id}/versions`. Routes to the correct upload endpoint based on `type`. When `wait-for-completion` is true, polls `GET /scans?filter=projectVersion=={pvId}` until complete or timed out.

**Examples:**

```yaml
# Binary SCA scan
- uses: finite-state/upload-scan@v1
  with:
    type: sca
    file: build/firmware.bin
    version: 'v${{ github.sha }}'

# Third-party scan results
- uses: finite-state/upload-scan@v1
  with:
    type: third-party
    scanner-type: grype
    file: grype-results.json

# SBOM import
- uses: finite-state/upload-scan@v1
  with:
    type: sbom
    sbom-format: cdx
    file: sbom.json
```

---

### run-report

Wraps `fs-report` as the findings/reporting engine. Installs fs-report, runs recipes, parses outputs, and uploads report artifacts.

**Usage:** `finite-state/run-report@v1`

**Inputs:**

| Input               | Required | Default        | Description                                             |
| ------------------- | -------- | -------------- | ------------------------------------------------------- |
| `recipe`            | yes      | —              | Recipe name(s), comma-separated                         |
| `project-id`        | no       | from setup     | Falls back to setup context                             |
| `version-id`        | no       | —              | Pin to specific version                                 |
| `baseline-version`  | no       | —              | For Version Comparison recipe                           |
| `current-version`   | no       | —              | For Version Comparison recipe                           |
| `period`            | no       | —              | Time period, e.g. `30d`, `1m`                           |
| `cve`               | no       | —              | CVE ID(s) for CVE Impact recipe                         |
| `finding-types`     | no       | —              | Filter: `cve`, `sast`, etc.                             |
| `open-only`         | no       | `true`         | Only include open findings                              |
| `scoring-file`      | no       | —              | Path to custom scoring YAML for Triage Prioritization   |
| `ai`                | no       | `false`        | Enable AI analysis (requires AI provider key as secret) |
| `ai-prompts`        | no       | `false`        | Generate AI prompts without calling AI API              |
| `output-dir`        | no       | `./fs-reports` | Output directory                                        |
| `fs-report-version` | no       | latest         | Pin fs-report version                                   |
| `cache-ttl`         | no       | `1`            | API cache TTL in hours (1h default for CI)              |
| `extra-args`        | no       | —              | Passthrough for additional fs-report flags              |

**Outputs:**

| Output           | Description                                               |
| ---------------- | --------------------------------------------------------- |
| `report-dir`     | Path to generated reports directory                       |
| `artifact-name`  | Uploaded workflow artifact name                           |
| `summary-json`   | JSON string with key metrics extracted from reports       |
| `critical-count` | Findings in CRITICAL/P0 band (from Triage Prioritization) |
| `high-count`     | Findings in HIGH/P1 band                                  |
| `new-findings`   | New findings count (from Version Comparison)              |
| `fixed-findings` | Fixed findings count (from Version Comparison)            |

**Behavior:** Installs `fs-report` via `pipx` (cached across runs). Sets auth from setup context. Runs `fs-report run --headless` with specified recipes. Parses CSV/JSON/MD outputs to extract key metrics. Always uploads the full report directory as a workflow artifact.

**Available recipes** (see fs-report-recipes skill for full details):

| Recipe                           | Scope                  | Key outputs                                           |
| -------------------------------- | ---------------------- | ----------------------------------------------------- |
| Executive Summary                | Portfolio              | HTML overview with severity charts                    |
| Scan Analysis                    | Portfolio              | Scan throughput, completion rates                     |
| Triage Prioritization            | Project/Folder         | Priority-banded findings + `vex_recommendations.json` |
| Version Comparison               | Project                | Delta findings, component churn                       |
| Remediation Package              | Project                | Component-centric action cards with upgrade paths     |
| CVE Impact                       | Portfolio (CVE-scoped) | Per-CVE dossier across all projects                   |
| Findings by Project              | Project/Folder         | Full findings inventory                               |
| Component List                   | Project/Folder         | SBOM component inventory                              |
| Component Vulnerability Analysis | Project/Folder         | Components ranked by composite risk                   |

**Examples:**

```yaml
# Triage Prioritization with custom scoring
- uses: finite-state/run-report@v1
  id: triage
  with:
    recipe: 'Triage Prioritization'
    period: 30d
    scoring-file: .github/fs-scoring.yaml

# Multiple recipes in one run
- uses: finite-state/run-report@v1
  id: report
  with:
    recipe: 'Triage Prioritization,Version Comparison,Remediation Package'
    period: 30d
    ai: true
```

---

### quality-gate

Consumes outputs from `run-report` to pass/fail the workflow. Supports three gating modes that can be combined (AND'd).

**Usage:** `finite-state/quality-gate@v1`

**Inputs:**

| Input          | Required | Default         | Description                                                       |
| -------------- | -------- | --------------- | ----------------------------------------------------------------- |
| `mode`         | yes      | —               | `delta`, `threshold`, `triage-priority`, or comma-separated combo |
| `report-dir`   | no       | from run-report | Path to fs-report output                                          |
| `summary-json` | no       | from run-report | Direct JSON from run-report outputs                               |

**Delta mode inputs:**

| Input              | Default | Description                                      |
| ------------------ | ------- | ------------------------------------------------ |
| `max-new-critical` | `0`     | Max allowed new critical findings                |
| `max-new-high`     | `0`     | Max allowed new high findings                    |
| `max-new-medium`   | `-1`    | Max allowed new medium findings (-1 = unlimited) |

**Threshold mode inputs:**

| Input          | Default | Description                              |
| -------------- | ------- | ---------------------------------------- |
| `max-critical` | —       | Max total critical findings              |
| `max-high`     | —       | Max total high findings                  |
| `max-total`    | —       | Max total findings across all severities |

**Triage priority mode inputs:**

| Input         | Default       | Description                              |
| ------------- | ------------- | ---------------------------------------- |
| `fail-on-p0`  | `true`        | Fail if any P0 (CRITICAL band) findings  |
| `fail-on-p1`  | `false`       | Fail if any P1 (HIGH band) findings      |
| `max-p0`      | `0`           | Max allowed P0 findings                  |
| `max-p1`      | `-1`          | Max allowed P1 findings (-1 = unlimited) |
| `ai`          | `false`       | Enable AI-powered triage analysis        |
| `ai-provider` | auto-detected | `anthropic`, `openai`, or `copilot`      |

**Outputs:**

| Output         | Description                               |
| -------------- | ----------------------------------------- |
| `result`       | `pass` or `fail`                          |
| `summary`      | Human-readable summary of gate evaluation |
| `details-json` | Full evaluation details as JSON           |

**Behavior:** Reads structured data from run-report outputs. Evaluates each active mode independently. All modes are AND'd -- all must pass for the gate to pass. Exit code 0 = pass, 1 = fail.

**Triage priority scoring model:**

- Gate 1 (P0/CRITICAL): `reachability_score > 0` AND (`has_exploit == true` OR `in_kev == true`)
- Gate 2 (P1/HIGH): `reachability_score >= 0` AND `attack_vector in ["NETWORK"]` AND `epss_percentile > 0.9`
- Remaining findings scored additively and banded into P2 (MEDIUM) / P3 (LOW/INFO)

Custom scoring weights can be provided via `scoring-file` in the upstream `run-report` step.

**Example:**

```yaml
- uses: finite-state/quality-gate@v1
  id: gate
  with:
    mode: delta,triage-priority
    max-new-critical: 0
    max-new-high: 0
    fail-on-p0: true
    report-dir: ${{ steps.report.outputs.report-dir }}
```

---

### pr-comment

Posts a findings summary as a PR comment, updated on each push (edit-in-place, not spam).

**Usage:** `finite-state/pr-comment@v1`

**Inputs:**

| Input              | Required | Default         | Description                                             |
| ------------------ | -------- | --------------- | ------------------------------------------------------- |
| `report-dir`       | no       | from run-report | Path to fs-report output                                |
| `summary-json`     | no       | from run-report | Direct JSON from run-report outputs                     |
| `template`         | no       | `summary`       | `summary`, `detailed`, `triage`, `comparison`, `custom` |
| `custom-template`  | no       | —               | Path to a custom Handlebars template file               |
| `gate-result`      | no       | —               | Pass/fail from quality-gate to include in comment       |
| `gate-summary`     | no       | —               | Gate evaluation summary text                            |
| `comment-tag`      | no       | `finite-state`  | Unique tag for edit-in-place                            |
| `collapse-details` | no       | `true`          | Wrap detailed findings in `<details>`                   |

**Built-in templates:**

| Template     | Content                                                                        |
| ------------ | ------------------------------------------------------------------------------ |
| `summary`    | Compact severity overview with gate status and report artifact links           |
| `triage`     | P0/P1/P2/P3 band counts, gate status per band, top P0/P1 findings listed       |
| `comparison` | Version delta table (baseline vs current), new/fixed findings, component churn |
| `detailed`   | Full findings table collapsed in `<details>` by default                        |
| `custom`     | User-provided Handlebars template with access to all report data               |

**Outputs:**

| Output        | Description                |
| ------------- | -------------------------- |
| `comment-id`  | The PR comment ID          |
| `comment-url` | Direct link to the comment |

**Behavior:** Reads report data from run-report outputs. Renders selected template with report data + gate results. Searches for existing PR comment by `comment-tag` marker. Creates or updates the comment (edit-in-place). Links to uploaded report artifacts.

**Example:**

```yaml
- uses: finite-state/pr-comment@v1
  if: always()
  with:
    template: triage
    gate-result: ${{ steps.gate.outputs.result }}
    gate-summary: ${{ steps.gate.outputs.summary }}
    report-dir: ${{ steps.report.outputs.report-dir }}
```

**Important:** Always use `if: always()` so the comment is posted even when the quality gate fails.

---

### download-sbom

Exports the FS-generated SBOM back into the workflow as a file and/or artifact.

**Usage:** `finite-state/download-sbom@v1`

**Inputs:**

| Input             | Required | Default                | Description                                       |
| ----------------- | -------- | ---------------------- | ------------------------------------------------- |
| `version-id`      | no       | from setup/upload-scan | Falls back to setup context or upload-scan output |
| `format`          | no       | `cyclonedx`            | `cyclonedx` or `spdx`                             |
| `include-vex`     | no       | `true`                 | Include VEX triage data in SBOM                   |
| `output-file`     | no       | `sbom.json`            | Output file path                                  |
| `upload-artifact` | no       | `true`                 | Upload as workflow artifact                       |
| `artifact-name`   | no       | `finite-state-sbom`    | Artifact name                                     |

**Outputs:**

| Output            | Description                      |
| ----------------- | -------------------------------- |
| `file`            | Path to the downloaded SBOM file |
| `artifact-name`   | Uploaded artifact name           |
| `component-count` | Number of components in the SBOM |

**Behavior:** Calls `GET /sboms/cyclonedx/{pvId}` or `GET /sboms/spdx/{pvId}`. Writes to output file. Optionally uploads as workflow artifact. This is the one action that calls the API directly (not through fs-report) since fs-report does not handle SBOM export.

**Example:**

```yaml
- uses: finite-state/download-sbom@v1
  with:
    format: cyclonedx
    include-vex: true
    output-file: sbom-with-vex.json
```

---

## Action Chaining

Actions pass data via GitHub Actions step outputs and environment variables. The `setup` action exports environment variables that persist for the entire job.

### Data flow diagram

```
setup
  |-- exports: FINITE_STATE_AUTH_TOKEN, FINITE_STATE_DOMAIN (env vars for entire job)
  |-- outputs: project-id, version-id, org-name, user
  |
  v
upload-scan (reads env + setup outputs)
  |-- outputs: scan-id, version-id, scan-status
  |
  v
run-report (reads env + setup/upload-scan outputs)
  |-- outputs: report-dir, artifact-name, summary-json, critical-count, etc.
  |-- uploads: full report directory as workflow artifact
  |
  +---> quality-gate (reads report-dir or summary-json)
  |       |-- outputs: result, summary, details-json
  |
  +---> pr-comment (reads report-dir or summary-json + gate outputs)
  |       |-- outputs: comment-id, comment-url
  |
  v
download-sbom (reads env + setup/upload-scan outputs)
  |-- outputs: file, artifact-name, component-count
```

### Key chaining rules

1. **setup is always first** -- it provides auth context via env vars. All other actions inherit it automatically.
2. **upload-scan before run-report** -- the scan must complete before reports can analyze it.
3. **run-report before quality-gate and pr-comment** -- both consume report outputs.
4. **quality-gate before pr-comment** (optional) -- if you want gate results in the PR comment, run the gate first.
5. **download-sbom is independent** -- it only needs setup context and optionally a version-id from upload-scan.
6. **Each action can run standalone** -- with explicit inputs instead of relying on upstream outputs.

### Referencing upstream outputs

Use `steps.<step-id>.outputs.<output-name>`:

```yaml
- uses: finite-state/setup@v1
  id: fs
  with:
    api-token: ${{ secrets.FINITE_STATE_AUTH_TOKEN }}

- uses: finite-state/upload-scan@v1
  id: scan
  with:
    type: sca
    file: build/firmware.bin

# Reference upload-scan's version-id
- uses: finite-state/run-report@v1
  id: report
  with:
    recipe: 'Triage Prioritization'
    version-id: ${{ steps.scan.outputs.version-id }}

# Reference run-report's outputs
- uses: finite-state/quality-gate@v1
  id: gate
  with:
    mode: triage-priority
    report-dir: ${{ steps.report.outputs.report-dir }}

# Reference both report and gate outputs
- uses: finite-state/pr-comment@v1
  with:
    report-dir: ${{ steps.report.outputs.report-dir }}
    gate-result: ${{ steps.gate.outputs.result }}
```

---

## Common Workflow Recipes

### PR Gate (upload-and-gate)

The most common pattern. Scans on every PR, gates on findings, posts results as a comment.

**When to use:** Customer wants to block PRs that introduce new vulnerabilities.

```yaml
name: Finite State Security Gate
on:
  pull_request:
    branches: [main]

jobs:
  security:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: finite-state/setup@v1
        with:
          api-token: ${{ secrets.FINITE_STATE_AUTH_TOKEN }}
          domain: ${{ vars.FINITE_STATE_DOMAIN }}
          project-id: ${{ vars.FINITE_STATE_PROJECT_ID }}

      - uses: finite-state/upload-scan@v1
        with:
          type: sca
          file: build/firmware.bin
          version: 'pr-${{ github.event.number }}'

      - uses: finite-state/run-report@v1
        id: report
        with:
          recipe: 'Triage Prioritization,Version Comparison'
          period: 30d

      - uses: finite-state/quality-gate@v1
        id: gate
        with:
          mode: delta,triage-priority
          max-new-critical: 0
          fail-on-p0: true

      - uses: finite-state/pr-comment@v1
        if: always()
        with:
          template: triage
          gate-result: ${{ steps.gate.outputs.result }}
          gate-summary: ${{ steps.gate.outputs.summary }}
```

**Key points:**

- Version named `pr-<number>` for traceability
- Combines delta + triage-priority gating for defense in depth
- `if: always()` on pr-comment ensures the comment is posted even when the gate fails
- Reports are always uploaded as artifacts regardless of gate result

---

### Nightly Reports (scheduled)

Generates comprehensive reports on a schedule without gating.

**When to use:** Customer wants periodic security reports for management review or compliance.

```yaml
name: Nightly Security Report
on:
  schedule:
    - cron: '0 2 * * *' # 2 AM UTC daily
  workflow_dispatch: {} # Allow manual trigger

jobs:
  report:
    runs-on: ubuntu-latest
    steps:
      - uses: finite-state/setup@v1
        with:
          api-token: ${{ secrets.FINITE_STATE_AUTH_TOKEN }}
          domain: ${{ vars.FINITE_STATE_DOMAIN }}
          project-id: ${{ vars.FINITE_STATE_PROJECT_ID }}

      - uses: finite-state/run-report@v1
        with:
          recipe: 'Executive Summary,Triage Prioritization,Remediation Package'
          period: 30d
          scoring-file: .github/fs-scoring.yaml
          ai: true
```

**Key points:**

- No upload-scan step needed -- reports run against existing platform data
- Multiple recipes in a single run for a comprehensive view
- AI analysis enabled for richer triage insights
- Reports uploaded as artifacts -- download from the Actions run page
- `workflow_dispatch` allows on-demand runs

---

### SBOM Export

Exports the FS-generated SBOM (with VEX data) as a workflow artifact.

**When to use:** Customer needs SBOMs for compliance, supply chain transparency, or downstream consumption.

```yaml
name: SBOM Export
on:
  release:
    types: [published]
  workflow_dispatch: {}

jobs:
  sbom:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: finite-state/setup@v1
        with:
          api-token: ${{ secrets.FINITE_STATE_AUTH_TOKEN }}
          domain: ${{ vars.FINITE_STATE_DOMAIN }}
          project-id: ${{ vars.FINITE_STATE_PROJECT_ID }}

      - uses: finite-state/upload-scan@v1
        id: scan
        with:
          type: sca
          file: build/firmware.bin
          version: '${{ github.ref_name }}'

      - uses: finite-state/download-sbom@v1
        with:
          version-id: ${{ steps.scan.outputs.version-id }}
          format: cyclonedx
          include-vex: true
          artifact-name: 'sbom-${{ github.ref_name }}'
```

**Key points:**

- Triggered on release for versioned SBOMs
- Version named after the release tag for traceability
- `include-vex: true` bundles triage decisions into the SBOM
- SBOM artifact can be attached to the GitHub release or consumed by downstream systems

---

### Full Pipeline (all actions)

Uses every action for maximum coverage: scan, report, gate, comment, and SBOM export.

**When to use:** Customer wants the complete Finite State integration.

```yaml
name: Finite State Full Pipeline
on:
  pull_request:
    branches: [main]

jobs:
  security:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # 1. Auth
      - uses: finite-state/setup@v1
        with:
          api-token: ${{ secrets.FINITE_STATE_AUTH_TOKEN }}
          domain: ${{ vars.FINITE_STATE_DOMAIN }}
          project-id: ${{ vars.FINITE_STATE_PROJECT_ID }}

      # 2. Upload and scan
      - uses: finite-state/upload-scan@v1
        id: scan
        with:
          type: sca
          file: build/firmware.bin
          version: 'pr-${{ github.event.number }}'

      # 3. Generate reports (multiple recipes)
      - uses: finite-state/run-report@v1
        id: report
        with:
          recipe: 'Triage Prioritization,Version Comparison,Remediation Package'
          period: 30d
          scoring-file: .github/fs-scoring.yaml
          ai: true

      # 4. Quality gate
      - uses: finite-state/quality-gate@v1
        id: gate
        with:
          mode: delta,threshold,triage-priority
          max-new-critical: 0
          max-new-high: 0
          max-critical: 5
          fail-on-p0: true

      # 5. PR comment (always runs)
      - uses: finite-state/pr-comment@v1
        if: always()
        with:
          template: triage
          gate-result: ${{ steps.gate.outputs.result }}
          gate-summary: ${{ steps.gate.outputs.summary }}
          report-dir: ${{ steps.report.outputs.report-dir }}

      # 6. Export SBOM
      - uses: finite-state/download-sbom@v1
        if: always()
        with:
          version-id: ${{ steps.scan.outputs.version-id }}
          format: cyclonedx
          include-vex: true
```

**Key points:**

- All three gate modes combined (delta + threshold + triage-priority)
- AI-enabled triage for enhanced scoring
- Custom scoring file committed to the repo
- PR comment and SBOM export run even if gate fails (`if: always()`)
- Reports uploaded as artifacts for detailed review

---

## Troubleshooting Guide

### Authentication failures

| Symptom                                 | Cause                              | Fix                                                                                                  |
| --------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `setup` fails with "401 Unauthorized"   | Invalid or expired API token       | Regenerate token in FS platform (Settings > API Tokens) and update `secrets.FINITE_STATE_AUTH_TOKEN` |
| `setup` fails with "403 Forbidden"      | Token lacks required permissions   | Ensure token has read/write access to the target project                                             |
| Downstream action fails with auth error | `setup` step was not run or failed | Add `finite-state/setup@v1` as the first step; check that it succeeded                               |
| Auth works locally but fails in CI      | Token stored incorrectly           | Verify the secret is set at the correct scope (repo or org) and the workflow has access              |

### Scan timeouts

| Symptom                                   | Cause                                       | Fix                                                                |
| ----------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------ |
| `upload-scan` fails with "Scan timed out" | Large binary exceeding default 600s timeout | Increase `timeout` input (e.g., `timeout: 1800` for 30 minutes)    |
| Scan stuck in `PROCESSING`                | Platform-side processing delay              | Check FS platform dashboard for scan status; retry if needed       |
| `upload-scan` fails with "File not found" | Build artifact not available                | Ensure the build step runs before upload-scan; check the file path |

### Quality gate failures

| Symptom                                  | Cause                                   | Fix                                                                              |
| ---------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------- |
| Gate fails unexpectedly                  | Thresholds too strict for current state | Review `steps.gate.outputs.summary` for details; adjust thresholds gradually     |
| Gate always passes                       | Mode not configured correctly           | Verify `mode` input includes the desired modes (e.g., `delta,triage-priority`)   |
| P0 findings causing failures             | Legitimate critical findings            | Triage findings in the FS platform (VEX status), then re-run; or adjust `max-p0` |
| Delta mode shows unexpected new findings | Baseline version mismatch               | Verify Version Comparison has correct baseline; check `period` parameter         |

### PR comment issues

| Symptom                               | Cause                                   | Fix                                                               |
| ------------------------------------- | --------------------------------------- | ----------------------------------------------------------------- |
| Comment not appearing                 | Missing `GITHUB_TOKEN` permissions      | Add `permissions: pull-requests: write` to the job                |
| Multiple comments instead of updating | Different `comment-tag` values          | Use the same `comment-tag` (default: `finite-state`) across runs  |
| Comment shows no data                 | `run-report` step failed or was skipped | Check that run-report succeeded; use `if: always()` on pr-comment |

### Version naming

| Pattern          | When to use           | Example                                    |
| ---------------- | --------------------- | ------------------------------------------ |
| `pr-<number>`    | PR workflows          | `version: "pr-${{ github.event.number }}"` |
| `<tag>`          | Release workflows     | `version: "${{ github.ref_name }}"`        |
| `<sha-short>`    | Commit-level tracking | `version: "${{ github.sha }}"`             |
| `nightly-<date>` | Scheduled workflows   | `version: "nightly-$(date +%Y%m%d)"`       |

---

## Onboarding Assistance

### Prerequisites

1. **Finite State account** with API access enabled
2. **API token** generated from the FS platform (Settings > API Tokens)
3. **Project ID** for the target project (visible in the platform URL: `app.finitestate.io/projects/<id>`)

### Step-by-step setup

**Step 1: Add secrets and variables to the GitHub repo**

| Name                      | Type     | Where to find                                                                  |
| ------------------------- | -------- | ------------------------------------------------------------------------------ |
| `FINITE_STATE_AUTH_TOKEN` | Secret   | FS platform > Settings > API Tokens > Generate                                 |
| `FINITE_STATE_DOMAIN`     | Variable | Your platform domain (e.g., `app.finitestate.io` or `customer.finitestate.io`) |
| `FINITE_STATE_PROJECT_ID` | Variable | FS platform > Projects > select project > copy ID from URL                     |

Navigate to GitHub repo > Settings > Secrets and variables > Actions.

**Step 2: Choose a workflow template**

Pick the template that matches the customer's needs:

| Need               | Template           | File                               |
| ------------------ | ------------------ | ---------------------------------- |
| PR security gating | upload-and-gate    | `templates/upload-and-gate.yml`    |
| Nightly reports    | nightly-report     | `templates/nightly-report.yml`     |
| SBOM export        | sbom-export        | `templates/sbom-export.yml`        |
| PR comments only   | upload-and-comment | `templates/upload-and-comment.yml` |
| Everything         | full-pipeline      | `templates/full-pipeline.yml`      |

**Step 3: Copy the workflow file**

Copy the template to `.github/workflows/finite-state.yml` in the customer's repo. Update the `file` input in `upload-scan` to point to their actual build artifact.

**Step 4: (Optional) Use the CLI wizard**

```bash
npx finite-state-actions init
```

Interactive prompts guide through scan type, quality gates, PR comments, and SBOM export. Generates a tailored workflow file.

**Step 5: (Optional) Customize triage scoring**

Create `.github/fs-scoring.yaml` with custom scoring weights. Same format as fs-report's `--scoring-file`. Can be tuned interactively in Forge via `configure_scoring`, then committed for CI.

### How to find the project ID

1. Log into the FS platform
2. Navigate to Projects
3. Select the target project
4. The project ID is in the URL: `https://app.finitestate.io/projects/<PROJECT_ID>`
5. Or use the API: `GET /public/v0/projects?filter=name=="My Project"`

### How to generate an API token

1. Log into the FS platform
2. Navigate to Settings > API Tokens
3. Click "Generate New Token"
4. Copy the token immediately (it won't be shown again)
5. Add it as a secret in GitHub: repo Settings > Secrets > Actions > New repository secret > Name: `FINITE_STATE_AUTH_TOKEN`

---

## Cross-References

| Skill                 | Relationship                                                                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **fs-api**            | The REST API that all actions call. `setup` validates via `/authUser`. `upload-scan` calls `/scans`. `download-sbom` calls `/sboms`. See fs-api for endpoint details, pagination, and error codes.            |
| **fs-report-cli**     | The CLI tool that `run-report` wraps. All recipe execution, output formats, and scoring configuration are fs-report features. See fs-report-cli for CLI flags, output structure, and caching.                 |
| **fs-report-recipes** | The recipe catalog available in `run-report`. Each recipe has specific inputs, outputs, and use cases. See fs-report-recipes for recipe details, output files, and combination patterns.                      |
| **fs-platform**       | Platform concepts (organizations, projects, versions, findings, VEX). Understanding the data model helps configure actions correctly. See fs-platform for hierarchy, finding lifecycle, and triage workflows. |

### Forge MCP tool connections

| Forge Tool            | Related Action                     | Connection                                                 |
| --------------------- | ---------------------------------- | ---------------------------------------------------------- |
| `generate_workflow`   | All actions                        | Generates complete workflow YAML using these actions       |
| `configure_gate`      | quality-gate                       | Produces the quality-gate step YAML with configured inputs |
| `configure_scoring`   | run-report                         | Produces `scoring.yaml` for the `scoring-file` input       |
| `get_ci_status`       | All actions                        | Checks workflow run status                                 |
| `get_gate_results`    | quality-gate                       | Reads gate evaluation from workflow run                    |
| `get_pr_findings`     | pr-comment                         | Parses the PR comment for findings data                    |
| `trigger_scan`        | upload-scan                        | Dispatches a workflow run                                  |
| `run_triage_pipeline` | run-report (Triage Prioritization) | Same scoring model, same `scoring.yaml` format             |
| `run_full_assessment` | run-report                         | Same report formats                                        |
