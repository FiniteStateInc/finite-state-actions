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

**Usage:** `finite-state/setup@v2`

**Inputs:**

| Input          | Required | Default              | Description                                                                 |
| -------------- | -------- | -------------------- | --------------------------------------------------------------------------- |
| `api-token`    | yes      | —                    | FS API token (store in `secrets.FINITE_STATE_AUTH_TOKEN`)                   |
| `domain`       | no       | `app.finitestate.io` | Platform domain                                                             |
| `project-id`   | no       | —                    | Default project ID for subsequent actions                                   |
| `project-name` | no       | —                    | Exact project name, resolved to an ID. Mutually exclusive with `project-id` |
| `version-id`   | no       | —                    | Default version ID for subsequent actions                                   |

**Outputs:**

| Output       | Description                   |
| ------------ | ----------------------------- |
| `project-id` | Echoed or resolved project ID |
| `version-id` | Echoed or resolved version ID |

> The `org-name` and `user` outputs were removed along with the `/authUser` call — `setup` no longer reads the authenticated identity.

**Behavior:** Installs `fs-cli` (see below), which doubles as the token check: the download endpoint is authenticated and 401/403 is non-retryable, so a bad token or a domain from the wrong tenant fails in this first step with a message naming both. Exports `FINITE_STATE_AUTH_TOKEN` and `FINITE_STATE_DOMAIN` as environment variables so downstream actions inherit auth without re-specifying.

**Unknown `project-name` is not fatal (v2.1 and later):** if the name matches no existing project, `setup` logs a warning, skips the project ID, and exports the requested name as `FINITE_STATE_PROJECT_NAME`. `scan` then passes it as `fs-cli --name`, so the platform creates the project on the first scan under the name you asked for rather than the repository name. A name matching **more than one** project still fails — there is no safe guess.

**fs-cli installation (v2 and later):** `setup` calls `GET /public/v0/cli/download?os=<os>&arch=<arch>` with the API token, downloads the binary from the returned pre-signed URL into `$RUNNER_TEMP/fs-cli`, `chmod 0755`s it, and adds that directory to `PATH`. Notes:

- The runner needs no `jq`, `sudo`, or write access to `/usr/local/bin` — everything happens under `RUNNER_TEMP`.
- The download is token-authenticated, so an expired or scope-limited token fails here rather than at scan time.
- `os` maps from the runner as `linux`, `darwin`, or `windows`; `arch` maps to `amd64` (x64) or `arm64`. Any other platform fails fast.
- `PATH` is exported for subsequent steps in the same job only — a later job must run `setup` again.
- v1 installed fs-cli by piping a `customer-resources` install script to `sh`; that path is gone in v2.

**Example:**

```yaml
- uses: finite-state/setup@v2
  id: fs
  with:
    api-token: ${{ secrets.FINITE_STATE_AUTH_TOKEN }}
    domain: ${{ vars.FINITE_STATE_DOMAIN }}
    project-id: ${{ vars.FINITE_STATE_PROJECT_ID }}
```

---

### scan

Runs `fs-cli scan` to analyze project dependencies and upload results to the Finite State platform.

**Standalone use (v2.1 and later):** `setup` is optional. Pass `api-token` (and `domain`/`project-name` as needed) directly to `scan` and it downloads fs-cli itself. When `setup` did run, `scan` reuses the fs-cli already on `PATH` and inherits auth from the exported env — no second download.

**Usage:** `finite-state/scan@v2`

**Inputs:**

| Input          | Required | Default    | Description                                                             |
| -------------- | -------- | ---------- | ----------------------------------------------------------------------- |
| `api-token`    | no       | from setup | FS API token. Required only when `setup` did not run in this job        |
| `domain`       | no       | from setup | Platform domain. Falls back to setup context, then `app.finitestate.io` |
| `project-name` | no       | —          | Alias for `name`; created by the platform if it does not exist          |
| `dir`          | no       | `.`        | Directory to scan                                                       |
| `project-id`   | no       | from setup | Platform project ID. Overrides value from setup.                        |
| `version`      | yes      | —          | Version label for the scan (e.g. `v1.2.3` or `pr-42`)                   |
| `name`         | no       | repo name  | Project name sent to the platform. Defaults to repository name.         |
| `extra-args`   | no       | —          | Additional arguments passed to `fs-cli scan`                            |

**Outputs:**

| Output      | Description           |
| ----------- | --------------------- |
| `exit-code` | Exit code from fs-cli |

**Behavior:** Reads auth context from the `setup` action's exported environment variables. Always passes `--name` to `fs-cli` (required); adds `--project-id` when available. The `name` input defaults to the repository name extracted from `GITHUB_REPOSITORY`.

**Gotchas:**

- **`setup` is optional as of v2.1.** Without it, pass `api-token` to `scan`; it resolves fs-cli via `PATH` and downloads it when absent. Chaining `setup` first is still cheaper across multi-step jobs, since the download happens once.
- **`--name` is always sent, even with a project ID.** `fs-cli` requires it. If the `name` input is empty and `GITHUB_REPOSITORY` is unset (act, self-hosted shims, reusable-workflow edge cases), the action fails fast with `name is required`.
- **`name` resolution order is `name` input → `FINITE_STATE_PROJECT_NAME` from setup's `project-name` → repo name.** The repo-name fallback is the bare name, not `owner/repo`.
- **`project-id` is forwarded verbatim to `fs-cli --project-id`.** Platform project IDs are signed 64-bit integers (e.g. `-4065045466680884751`), not UUIDs. To target a project by name, use `project-name` on `scan` or `setup` rather than putting a name here.
- **Invocation order is `fs-cli scan --endpoint … --token … --name … --version …`, then `--project-id` and any `extra-args`, with the scan target path last.**
- **`extra-args` is split on whitespace.** There is no shell-style quoting, so an argument containing a space becomes two arguments. Pass such values through a dedicated input or a config file instead.
- **The step fails on any non-zero `fs-cli` exit, but `exit-code` is still set.** Use `continue-on-error: true` plus `steps.<id>.outputs.exit-code` when you want to inspect the code rather than fail the job.

**Example:**

```yaml
- uses: finite-state/scan@v2
  with:
    version: ${{ github.ref_name }}
```

---

### upload

Uploads a binary, SBOM, or third-party scan results for analysis. Handles all upload types through a single action with a `type` input.

**Usage:** `finite-state/upload@v2`

> Renamed from `upload-scan` in v2. `actions/upload-scan` still resolves — it is a composite shim that forwards every input and output to `upload` and emits a deprecation warning. It will be removed in v3.

**Inputs:**

| Input                 | Required | Default    | Description                                                                                                                |
| --------------------- | -------- | ---------- | -------------------------------------------------------------------------------------------------------------------------- |
| `type`                | yes      | —          | `sca`, `sast`, `config`, `vulnerability-analysis`, `sbom`, `third-party`                                                   |
| `file`                | yes      | —          | Path to the file to upload                                                                                                 |
| `project-id`          | no       | from setup | Override project (falls back to setup context)                                                                             |
| `version`             | no       | —          | Version name — creates a new version if provided                                                                           |
| `version-id`          | no       | —          | Existing version ID (mutually exclusive with `version`)                                                                    |
| `scanner-type`        | no       | —          | Required for `third-party` — e.g., `grype`, `trivy`, `snyk`                                                                |
| `sbom-format`         | no       | —          | Required for `sbom` — `cdx` or `spdx`                                                                                      |
| `wait-for-completion` | no       | `false`    | Poll scan status until done. Off by default — the step returns once the file is accepted                                   |
| `timeout`             | no       | —          | Optional max wait in seconds, applied to the upload and again to the scan poll; unset leaves fs-cli its 30-minute defaults |

`project-type` is still accepted but ignored — `fs-cli` creates the project and the platform assigns its type. Passing it logs a warning.

**Upload type routing:** every type goes through `fs-cli`, not the REST API — the REST upload endpoint sits behind a ~4.5 MB serverless payload cap, and `fs-cli` streams instead.

| Type                     | fs-cli command       | Use case                                            |
| ------------------------ | -------------------- | --------------------------------------------------- |
| `sca`                    | `fs-cli upload`      | Binary SCA scan                                     |
| `sast`                   | `fs-cli upload`      | Static analysis                                     |
| `config`                 | `fs-cli upload`      | Configuration audit                                 |
| `vulnerability-analysis` | `fs-cli upload`      | Reachability analysis                               |
| `sbom`                   | `fs-cli import`      | CycloneDX/SPDX import                               |
| `third-party`            | `fs-cli third-party` | External scanner results (Grype, Trivy, Snyk, etc.) |

**Outputs:**

| Output        | Description                                                                    |
| ------------- | ------------------------------------------------------------------------------ |
| `version-id`  | The version ID (created or existing), read back from `fs-cli` output           |
| `scan-status` | `COMPLETED`, `FAILED`, `RUNNING`, `NOT_FOUND`, or `SUBMITTED` when not waiting |

> `scan-id` and `scan-ids` are no longer produced: `fs-cli` reports scans as a per-type rollup, not as individual scan record IDs. Use `version-id` downstream — every other action keys off it.

**Standalone use (v2.1 and later):** like `scan`, `upload` accepts `api-token`, `domain`, and `project-name` directly, so `setup` is optional. `fs-cli` find-or-creates both the project and the version, so a name that matches nothing is created on upload.

**Multiple types:** `type` accepts a comma-separated list (`sca,sast,config,vulnerability-analysis`) handled by one `fs-cli upload` invocation against one version. `sbom` and `third-party` use different commands, so they cannot be combined with each other or with the binary types — use one step per group.

**Globs:** `file` may be a glob, but it must match exactly one file — `target/*.jar` in a Maven build also matches `-sources.jar` and `-javadoc.jar`, so an ambiguous match fails with the list rather than uploading the wrong artifact.

**Behavior:** Passes the project/version locator straight to `fs-cli` (`--name`/`--version`, or `--project-id`/`--version-id` when known), which find-or-creates both. The version ID is parsed from the `project=… version=…` line `fs-cli` prints on success. `wait-for-completion` is off by default: the step finishes as soon as the upload is accepted, leaving the platform to scan in the background, and `scan-status` reports `SUBMITTED`. Opt in and `fs-cli query --type scan --wait --fail-on-scan-incomplete` polls until every scan for the version settles; a failed scan, a poll timeout, or a version with no scans then fails the step. Firmware scans routinely run past ten minutes, so set `timeout` generously — or leave it unset for fs-cli's 30-minute default — when you do wait. The API token is passed via `FS_TOKEN`, never on the command line. The only REST call the action makes is the `fs-cli` download when the binary is not already on `PATH`.

**Examples:**

```yaml
# Binary SCA scan
- uses: finite-state/upload@v2
  with:
    type: sca
    file: build/firmware.bin
    version: 'v${{ github.sha }}'

# Third-party scan results
- uses: finite-state/upload@v2
  with:
    type: third-party
    scanner-type: grype
    file: grype-results.json
    version: 'v${{ github.sha }}'

# SBOM import
- uses: finite-state/upload@v2
  with:
    type: sbom
    sbom-format: cdx
    file: sbom.json
    version: 'v${{ github.sha }}'
```

---

### run-report

Wraps `fs-report` as the findings/reporting engine. Installs fs-report, runs recipes, parses outputs, and uploads report artifacts.

**Usage:** `finite-state/run-report@v2`

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
- uses: finite-state/run-report@v2
  id: triage
  with:
    recipe: 'Triage Prioritization'
    period: 30d
    scoring-file: .github/fs-scoring.yaml

# Multiple recipes in one run
- uses: finite-state/run-report@v2
  id: report
  with:
    recipe: 'Triage Prioritization,Version Comparison,Remediation Package'
    period: 30d
    ai: true
```

---

### quality-gate

Consumes outputs from `run-report` to pass/fail the workflow. Supports three gating modes that can be combined (AND'd).

**Usage:** `finite-state/quality-gate@v2`

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
- uses: finite-state/quality-gate@v2
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

**Usage:** `finite-state/pr-comment@v2`

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
- uses: finite-state/pr-comment@v2
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

**Usage:** `finite-state/download-sbom@v2`

**Inputs:**

| Input             | Required | Default             | Description                                  |
| ----------------- | -------- | ------------------- | -------------------------------------------- |
| `version-id`      | no       | from setup/upload   | Falls back to setup context or upload output |
| `format`          | no       | `cyclonedx`         | `cyclonedx` or `spdx`                        |
| `include-vex`     | no       | `true`              | Include VEX triage data in SBOM              |
| `output-file`     | no       | `sbom.json`         | Output file path                             |
| `upload-artifact` | no       | `true`              | Upload as workflow artifact                  |
| `artifact-name`   | no       | `finite-state-sbom` | Artifact name                                |

**Outputs:**

| Output            | Description                      |
| ----------------- | -------------------------------- |
| `file`            | Path to the downloaded SBOM file |
| `artifact-name`   | Uploaded artifact name           |
| `component-count` | Number of components in the SBOM |

**Behavior:** Calls `GET /sboms/cyclonedx/{pvId}` or `GET /sboms/spdx/{pvId}`. Writes to output file. Optionally uploads as workflow artifact. This is the one action that calls the API directly (not through fs-report) since fs-report does not handle SBOM export.

**Example:**

```yaml
- uses: finite-state/download-sbom@v2
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
setup (validates auth, exports env vars, installs fs-cli)   [optional if only scan runs]
  |-- exports: FINITE_STATE_AUTH_TOKEN, FINITE_STATE_DOMAIN,
  |            FINITE_STATE_PROJECT_NAME (env vars for entire job)
  |-- outputs: project-id, version-id
  |
  +---> scan (runs fs-cli dependency scan, uploads results)
  |       |-- outputs: exit-code
  |
  +---> upload (uploads binary/SBOM/third-party results)
  |       |-- outputs: version-id, scan-status
  |
  v
run-report (reads env + setup/upload outputs)
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
download-sbom (reads env + setup/upload outputs)
  |-- outputs: file, artifact-name, component-count
```

### Key chaining rules

1. **setup comes first when used** -- it provides auth context via env vars, and installs fs-cli. Every action except `scan` requires it.
2. **upload before run-report** -- the scan must complete before reports can analyze it.
3. **run-report before quality-gate and pr-comment** -- both consume report outputs.
4. **quality-gate before pr-comment** (optional) -- if you want gate results in the PR comment, run the gate first.
5. **download-sbom is independent** -- it only needs setup context and optionally a version-id from upload.
6. **Only `scan` runs without setup** -- it accepts `api-token`/`domain`/`project-name` directly and downloads fs-cli when PATH has none. The other actions read auth from the env vars `setup` exports, though all of them accept explicit project/version inputs instead of upstream outputs.

### Referencing upstream outputs

Use `steps.<step-id>.outputs.<output-name>`:

```yaml
- uses: finite-state/setup@v2
  id: fs
  with:
    api-token: ${{ secrets.FINITE_STATE_AUTH_TOKEN }}

- uses: finite-state/upload@v2
  id: scan
  with:
    type: sca
    file: build/firmware.bin

# Reference upload's version-id
- uses: finite-state/run-report@v2
  id: report
  with:
    recipe: 'Triage Prioritization'
    version-id: ${{ steps.scan.outputs.version-id }}

# Reference run-report's outputs
- uses: finite-state/quality-gate@v2
  id: gate
  with:
    mode: triage-priority
    report-dir: ${{ steps.report.outputs.report-dir }}

# Reference both report and gate outputs
- uses: finite-state/pr-comment@v2
  with:
    report-dir: ${{ steps.report.outputs.report-dir }}
    gate-result: ${{ steps.gate.outputs.result }}
```

---

## Common Workflow Recipes

### Source scan (scan alone)

Smallest working pipeline — no `setup`, no pre-existing project. `scan` downloads fs-cli, authenticates from its own inputs, and the platform creates the project on first run.

```yaml
name: Finite State Security Scan
on:
  push:
    tags:
      - 'v*'
  workflow_dispatch: {}

jobs:
  security:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6

      - uses: finite-state/scan@v2
        with:
          api-token: ${{ secrets.FINITE_STATE_AUTH_TOKEN }}
          domain: ${{ vars.FINITE_STATE_DOMAIN }}
          project-name: ${{ github.event.repository.name }}
          version: ${{ github.ref_name }}
```

---

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

      - uses: finite-state/setup@v2
        with:
          api-token: ${{ secrets.FINITE_STATE_AUTH_TOKEN }}
          domain: ${{ vars.FINITE_STATE_DOMAIN }}
          project-id: ${{ vars.FINITE_STATE_PROJECT_ID }}

      - uses: finite-state/upload@v2
        with:
          type: sca
          file: build/firmware.bin
          version: 'pr-${{ github.event.number }}'

      - uses: finite-state/run-report@v2
        id: report
        with:
          recipe: 'Triage Prioritization,Version Comparison'
          period: 30d

      - uses: finite-state/quality-gate@v2
        id: gate
        with:
          mode: delta,triage-priority
          max-new-critical: 0
          fail-on-p0: true

      - uses: finite-state/pr-comment@v2
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
      - uses: finite-state/setup@v2
        with:
          api-token: ${{ secrets.FINITE_STATE_AUTH_TOKEN }}
          domain: ${{ vars.FINITE_STATE_DOMAIN }}
          project-id: ${{ vars.FINITE_STATE_PROJECT_ID }}

      - uses: finite-state/run-report@v2
        with:
          recipe: 'Executive Summary,Triage Prioritization,Remediation Package'
          period: 30d
          scoring-file: .github/fs-scoring.yaml
          ai: true
```

**Key points:**

- No upload step needed -- reports run against existing platform data
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

      - uses: finite-state/setup@v2
        with:
          api-token: ${{ secrets.FINITE_STATE_AUTH_TOKEN }}
          domain: ${{ vars.FINITE_STATE_DOMAIN }}
          project-id: ${{ vars.FINITE_STATE_PROJECT_ID }}

      - uses: finite-state/upload@v2
        id: scan
        with:
          type: sca
          file: build/firmware.bin
          version: '${{ github.ref_name }}'

      - uses: finite-state/download-sbom@v2
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
      - uses: finite-state/setup@v2
        with:
          api-token: ${{ secrets.FINITE_STATE_AUTH_TOKEN }}
          domain: ${{ vars.FINITE_STATE_DOMAIN }}
          project-id: ${{ vars.FINITE_STATE_PROJECT_ID }}

      # 2. Upload and scan
      - uses: finite-state/upload@v2
        id: scan
        with:
          type: sca
          file: build/firmware.bin
          version: 'pr-${{ github.event.number }}'

      # 3. Generate reports (multiple recipes)
      - uses: finite-state/run-report@v2
        id: report
        with:
          recipe: 'Triage Prioritization,Version Comparison,Remediation Package'
          period: 30d
          scoring-file: .github/fs-scoring.yaml
          ai: true

      # 4. Quality gate
      - uses: finite-state/quality-gate@v2
        id: gate
        with:
          mode: delta,threshold,triage-priority
          max-new-critical: 0
          max-new-high: 0
          max-critical: 5
          fail-on-p0: true

      # 5. PR comment (always runs)
      - uses: finite-state/pr-comment@v2
        if: always()
        with:
          template: triage
          gate-result: ${{ steps.gate.outputs.result }}
          gate-summary: ${{ steps.gate.outputs.summary }}
          report-dir: ${{ steps.report.outputs.report-dir }}

      # 6. Export SBOM
      - uses: finite-state/download-sbom@v2
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
| Downstream action fails with auth error | `setup` step was not run or failed | Add `finite-state/setup@v2` as the first step; check that it succeeded                               |
| Auth works locally but fails in CI      | Token stored incorrectly           | Verify the secret is set at the correct scope (repo or org) and the workflow has access              |

### Scan timeouts

| Symptom                              | Cause                                       | Fix                                                             |
| ------------------------------------ | ------------------------------------------- | --------------------------------------------------------------- |
| `upload` fails with "Scan timed out" | Large binary exceeding default 600s timeout | Increase `timeout` input (e.g., `timeout: 1800` for 30 minutes) |
| Scan stuck in `PROCESSING`           | Platform-side processing delay              | Check FS platform dashboard for scan status; retry if needed    |
| `upload` fails with "File not found" | Build artifact not available                | Ensure the build step runs before upload; check the file path   |

### Source scan (fs-cli)

| Symptom                                            | Cause                                                     | Fix                                                                                         |
| -------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `FINITE_STATE_AUTH_TOKEN is not set`               | Neither `setup` ran nor `api-token` was passed to `scan`  | Add `finite-state/setup`, or pass `api-token` directly to `scan`                            |
| `setup` fails with "not available for this runner" | Unsupported runner OS/arch for the fs-cli download        | Use a linux/darwin/windows runner on amd64 or arm64                                         |
| `setup` fails downloading fs-cli with HTTP 403     | Pre-signed download URL expired or the token was rejected | Re-run the job; if it persists, regenerate the API token                                    |
| `scan` fails with "name is required"               | Empty `name` input and no `GITHUB_REPOSITORY`             | Set the `name` input explicitly                                                             |
| Results land in an unexpected/new project          | `name` defaulted to the repo name and created a match     | Pin `project-id` on `setup`, or set `name` to the exact platform project name               |
| `upload` warns "Unexpected input(s) 'api-token'"   | Pinned to a build before standalone upload landed         | Repin to `@v2`; `api-token`/`domain`/`project-name`/`project-type` are supported inputs now |
| `upload` fails "matches N files"                   | A glob matched sources/javadoc jars too                   | Narrow it, e.g. `target/app-[0-9]*.jar`, or pass an exact path                              |
| `fs-cli` rejects `--project-id`                    | A project name was passed where an ID is expected         | Use `project-name` instead, and leave `project-id` unset                                    |
| Argument in `extra-args` arrives split or garbled  | `extra-args` is whitespace-split, no quoting support      | Avoid values containing spaces; use a config file for those                                 |
| Job fails but you wanted the raw exit code         | Non-zero `fs-cli` exit calls `setFailed`                  | Set `continue-on-error: true` and read `steps.<id>.outputs.exit-code`                       |

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
3. **Project name or ID** — a name is enough; the platform creates the project on the first scan if none matches. An existing project's ID is in the platform URL: `<domain>/projects/<id>`

### Step-by-step setup

**Step 1: Add secrets and variables to the GitHub repo**

| Name                      | Type     | Where to find                                                                                                                                                          |
| ------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FINITE_STATE_AUTH_TOKEN` | Secret   | FS platform > Settings > API Tokens > Generate                                                                                                                         |
| `FINITE_STATE_DOMAIN`     | Variable | The tenant the token was issued from (e.g., `app.finitestate.io` or `customer.finitestate.io`). A token used against another tenant authenticates but sees no projects |
| `FINITE_STATE_PROJECT_ID` | Variable | FS platform > Projects > select project > copy ID from URL                                                                                                             |

Navigate to GitHub repo > Settings > Secrets and variables > Actions.

**Step 2: Start from a workflow recipe**

Copy one of the workflows in "Common Workflow Recipes" above into `.github/workflows/finite-state.yml` and trim what the customer does not need. There is no template directory or `init` wizard in this repo — the recipes are the source of truth.

| Need               | Recipe                      |
| ------------------ | --------------------------- |
| Single-step scan   | Source scan (scan alone)    |
| PR security gating | PR Gate (upload-and-gate)   |
| Nightly reports    | Nightly Reports (scheduled) |
| SBOM export        | SBOM Export                 |
| Everything         | Full Pipeline (all actions) |

**Step 3: Point the workflow at real inputs**

Set `version` to a meaningful label (see "Version naming"), and for `upload` set `file` to the customer's actual build artifact.

**Step 4: (Optional) Customize triage scoring**

Commit a scoring YAML (same format as fs-report's `--scoring-file`) and pass it explicitly via `run-report`'s `scoring-file` input — it is not picked up by convention. Weights can be tuned interactively in Forge via `configure_scoring`, then committed for CI.

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

| Skill                 | Relationship                                                                                                                                                                                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **fs-api**            | The REST API. Most work now goes through `fs-cli` instead: `setup` only calls `/cli/download` (plus a project-name lookup), `scan` and `upload` only `/cli/download`, and `download-sbom` calls `/sboms`. See fs-api for endpoint details, pagination, and error codes. |
| **fs-report-cli**     | The CLI tool that `run-report` wraps. All recipe execution, output formats, and scoring configuration are fs-report features. See fs-report-cli for CLI flags, output structure, and caching.                                                                           |
| **fs-report-recipes** | The recipe catalog available in `run-report`. Each recipe has specific inputs, outputs, and use cases. See fs-report-recipes for recipe details, output files, and combination patterns.                                                                                |
| **fs-platform**       | Platform concepts (organizations, projects, versions, findings, VEX). Understanding the data model helps configure actions correctly. See fs-platform for hierarchy, finding lifecycle, and triage workflows.                                                           |

### Forge MCP tool connections

| Forge Tool            | Related Action                     | Connection                                                 |
| --------------------- | ---------------------------------- | ---------------------------------------------------------- |
| `generate_workflow`   | All actions                        | Generates complete workflow YAML using these actions       |
| `configure_gate`      | quality-gate                       | Produces the quality-gate step YAML with configured inputs |
| `configure_scoring`   | run-report                         | Produces `scoring.yaml` for the `scoring-file` input       |
| `get_ci_status`       | All actions                        | Checks workflow run status                                 |
| `get_gate_results`    | quality-gate                       | Reads gate evaluation from workflow run                    |
| `get_pr_findings`     | pr-comment                         | Parses the PR comment for findings data                    |
| `trigger_scan`        | upload                             | Dispatches a workflow run                                  |
| `run_triage_pipeline` | run-report (Triage Prioritization) | Same scoring model, same `scoring.yaml` format             |
| `run_full_assessment` | run-report                         | Same report formats                                        |
