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

A modular suite of GitHub Actions for the Finite State platform. Enables firmware/software security scanning, vulnerability gating, PR reporting, and SBOM export in CI/CD pipelines.

The actions live in subdirectories of a single monorepo, so every `uses:` needs the full path — `FiniteStateInc/finite-state-actions/actions/<name>@v2`. There is no short `finite-state/<name>` form.

**Repo:** `FiniteStateInc/finite-state-actions`
**Customer resources:** `customer-resources/02-ci-cd-automation/github-actions/`

---

## Action Catalog

### setup

Establishes authentication and configuration context for all downstream actions in the same job.

**Usage:** `FiniteStateInc/finite-state-actions/actions/setup@v2`

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

**fs-cli installation (v2 and later):** `setup` calls `GET https://<domain>/api/public/v0/cli/download?os=<os>&arch=<arch>` with the API token, downloads the binary from the returned pre-signed URL into `$RUNNER_TEMP/fs-cli`, `chmod 0755`s it, and adds that directory to `PATH`. Notes:

- The runner needs no `jq`, `sudo`, or write access to `/usr/local/bin` — everything happens under `RUNNER_TEMP`.
- The download is token-authenticated, so an expired or scope-limited token fails here rather than at scan time.
- `os` maps from the runner as `linux`, `darwin` (macOS), or `windows`; `arch` maps to `amd64` (Node's `x64`) or `arm64`. Any other platform or architecture fails fast, naming the runner values that were rejected.
- The bytes are verified against the runner before anything is written: the executable header (ELF `e_machine`, Mach-O `cputype`, PE `Machine`) must agree with the requested os/arch, so a Linux build on a Windows runner — or a JSON/HTML error page served in place of the binary — fails with a clear message instead of a cryptic exec error later. A machine value the check does not recognise is a failure, not a pass; only a universal Mach-O may leave the architecture unverified, since it carries several.
- Windows installs as `fs-cli.exe`; `ensureFsCli` also looks for `.exe`/`.cmd` when reusing an fs-cli already on `PATH`. A binary found on `PATH` gets the same header check — one built for another platform, or unreadable, is skipped with a warning and replaced by a download rather than exec'd.
- The endpoint returns the release `version` alongside the URL, and it is logged — check the step log to see which fs-cli a run actually used. SHA-256 and signature metadata live on the separate scanner update-check endpoint; the install path does not verify them today.
- `PATH` is exported for subsequent steps in the same job only — a later job must run `setup` again.
- v1 installed fs-cli by piping a `customer-resources` install script to `sh`; that path is gone in v2.

**Example:**

```yaml
- uses: FiniteStateInc/finite-state-actions/actions/setup@v2
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

**Usage:** `FiniteStateInc/finite-state-actions/actions/scan@v2`

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

| Output       | Description                                                                   |
| ------------ | ----------------------------------------------------------------------------- |
| `exit-code`  | Exit code from fs-cli                                                         |
| `project-id` | Project ID used: from the `project-id` input, from setup, or read from fs-cli |
| `version-id` | Version ID the platform resolved for the version label, read from fs-cli      |

**Behavior:** Reads auth context from the `setup` action's exported environment variables, then exports it again for later steps. Always passes `--name` to `fs-cli` (required); adds `--project-id` when available. The `name` input defaults to the repository name extracted from `GITHUB_REPOSITORY`.

**Gotchas:**

- **`setup` is optional as of v2.1.** Without it, pass `api-token` to `scan`; it resolves fs-cli via `PATH` and downloads it when absent. Chaining `setup` first is still cheaper across multi-step jobs, since the download happens once.
- **`--name` is always sent, even with a project ID.** `fs-cli` requires it. If the `name` input is empty and `GITHUB_REPOSITORY` is unset (act, self-hosted shims, reusable-workflow edge cases), the action fails fast with `name is required`.
- **`name` resolution order is `name` input → `FINITE_STATE_PROJECT_NAME` from setup's `project-name` → repo name.** The repo-name fallback is the bare name, not `owner/repo`.
- **`project-id` is forwarded verbatim to `fs-cli --project-id`.** Platform project IDs are signed 64-bit integers (e.g. `-4065045466680884751`), not UUIDs. To target a project by name, use `project-name` on `scan` or `setup` rather than putting a name here.
- **Invocation order is `fs-cli scan --endpoint … --token … --name … --version …`, then `--project-id` and any `extra-args`, with the scan target path last.**
- **`extra-args` is split on whitespace.** There is no shell-style quoting, so an argument containing a space becomes two arguments. Pass such values through a dedicated input or a config file instead.
- **`scan` exports the auth context, so later steps do not need it again.** It writes `FINITE_STATE_AUTH_TOKEN`, `FINITE_STATE_DOMAIN`, `FINITE_STATE_PROJECT_NAME` and (when known) `FINITE_STATE_PROJECT_ID` before fs-cli runs, so even an `if: always()` step inherits them.
- **The project and version IDs come from fs-cli's log output.** `scan` sends a version _label_; the platform decides which version that maps to and fs-cli reports it as `msg="using version" … id=…` and `submissionID=platform:<projectId>:<versionId>`. `scan` captures stdout **and stderr** (fs-cli logs to stderr), parses those, then exports `FINITE_STATE_PROJECT_ID`/`FINITE_STATE_VERSION_ID` and sets the matching outputs. No ID in the output means a warning, not a failure.
- **The step fails on any non-zero `fs-cli` exit, but `exit-code` is still set.** Use `continue-on-error: true` plus `steps.<id>.outputs.exit-code` when you want to inspect the code rather than fail the job.

**Example:**

```yaml
- uses: FiniteStateInc/finite-state-actions/actions/scan@v2
  with:
    version: ${{ github.ref_name }}
```

---

### upload

Uploads a binary, SBOM, or third-party scan results for analysis. Handles all upload types through a single action with a `type` input.

**Usage:** `FiniteStateInc/finite-state-actions/actions/upload@v2`

> Renamed from `upload-scan` in v2. `actions/upload-scan` still resolves — it is a composite shim that forwards every input and output to `upload`. The deprecation warning comes from GitHub itself, through a `deprecationMessage` on the `type` and `file` inputs, so the shim needs no shell and works on every runner OS. It will be removed in v3.

**Inputs:**

| Input                 | Required | Default    | Description                                                                                                                |
| --------------------- | -------- | ---------- | -------------------------------------------------------------------------------------------------------------------------- |
| `type`                | yes      | —          | `sca`, `sast`, `config`, `vulnerability-analysis`, `sbom`, `third-party`                                                   |
| `file`                | yes      | —          | Path to the file to upload. A glob is allowed if it matches exactly one file                                               |
| `api-token`           | no       | from setup | FS API token. Required only when `setup` did not run in this job                                                           |
| `domain`              | no       | from setup | Platform domain. Falls back to setup context, then `app.finitestate.io`                                                    |
| `project-id`          | no       | from setup | Override project (falls back to setup context)                                                                             |
| `project-name`        | no       | from setup | Project name, created if nothing matches. Ignored when `project-id` is set                                                 |
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

| Output        | Description                                                                            |
| ------------- | -------------------------------------------------------------------------------------- |
| `version-id`  | The version ID (created or existing), read back from `fs-cli` output                   |
| `project-id`  | The project ID used: from the `project-id` input, from setup, or read back from fs-cli |
| `scan-status` | `COMPLETED`, `FAILED`, `RUNNING`, `NOT_FOUND`, or `SUBMITTED` when not waiting         |

> `upload` also exports the auth context (`FINITE_STATE_AUTH_TOKEN`, `FINITE_STATE_DOMAIN`, `FINITE_STATE_PROJECT_NAME`) before the upload runs, and `FINITE_STATE_PROJECT_ID`/`FINITE_STATE_VERSION_ID` once fs-cli reports them — so a later `download-sbom` or `run-report` step needs no auth inputs of its own.

> `scan-id` and `scan-ids` are no longer produced: `fs-cli` reports scans as a per-type rollup, not as individual scan record IDs. Use `version-id` downstream — every other action keys off it.

**Standalone use (v2.1 and later):** like `scan`, `upload` accepts `api-token`, `domain`, and `project-name` directly, so `setup` is optional. `fs-cli` find-or-creates both the project and the version, so a name that matches nothing is created on upload.

**Multiple types:** `type` accepts a comma-separated list (`sca,sast,config,vulnerability-analysis`) handled by one `fs-cli upload` invocation against one version. `sbom` and `third-party` use different commands, so they cannot be combined with each other or with the binary types — use one step per group.

**Globs:** `file` may be a glob, but it must match exactly one file — `target/*.jar` in a Maven build also matches `-sources.jar` and `-javadoc.jar`, so an ambiguous match fails with the list rather than uploading the wrong artifact.

**`--name` is always required by fs-cli**, even when `project-id` is set (`config.go`: `if c.Name == ""`). `upload` uses `project-name`, then `setup`'s project name, then the repository name from `GITHUB_REPOSITORY`. Outside a GitHub runner with none of those set, it fails rather than sending the project ID as a name.

**Behavior:** Passes the project/version locator straight to `fs-cli` (`--name`/`--version`, or `--project-id`/`--version-id` when known), which find-or-creates both. The version ID is parsed from the `project=… version=…` line `fs-cli` prints on success. `wait-for-completion` is off by default: the step finishes as soon as the upload is accepted, leaving the platform to scan in the background, and `scan-status` reports `SUBMITTED`. Opt in and `fs-cli query --type scan --wait --fail-on-scan-incomplete` polls until every scan for the version settles; a failed scan, a poll timeout, or a version with no scans then fails the step. Firmware scans routinely run past ten minutes, so set `timeout` generously — or leave it unset for fs-cli's 30-minute default — when you do wait. `timeout` must be a whole number of seconds (`600s` and `10 minutes` are rejected rather than silently read as 600 and 10), and a value under 60 warns, since fs-cli's granularity is whole minutes. On a clean exit whose JSON output cannot be read the step reports `COMPLETED` from the exit code, which `--fail-on-scan-incomplete` makes authoritative — it never reads unreadable output as `NOT_FOUND`. A clean exit that nonetheless reports a non-completed rollup fails the step rather than publishing `FAILED` or `RUNNING` from a green job. The API token is passed via `FS_TOKEN`, never on the command line. The only REST call the action makes is the `fs-cli` download when the binary is not already on `PATH`.

**Examples:**

```yaml
# Binary SCA scan
- uses: FiniteStateInc/finite-state-actions/actions/upload@v2
  with:
    type: sca
    file: build/firmware.bin
    version: 'v${{ github.sha }}'

# Third-party scan results
- uses: FiniteStateInc/finite-state-actions/actions/upload@v2
  with:
    type: third-party
    scanner-type: grype
    file: grype-results.json
    version: 'v${{ github.sha }}'

# SBOM import
- uses: FiniteStateInc/finite-state-actions/actions/upload@v2
  with:
    type: sbom
    sbom-format: cdx
    file: sbom.json
    version: 'v${{ github.sha }}'
```

---

### run-report

Wraps `fs-report` as the findings/reporting engine. Installs fs-report, runs recipes, parses outputs, and uploads report artifacts.

**Usage:** `FiniteStateInc/finite-state-actions/actions/run-report@v2`

**Inputs:**

| Input               | Required | Default        | fs-report flag        | Description                                                                        |
| ------------------- | -------- | -------------- | --------------------- | ---------------------------------------------------------------------------------- |
| `recipe`            | yes      | —              | `--recipe` (repeated) | Recipe name(s) or slug(s), comma-separated                                         |
| `project-id`        | no       | from setup     | `--project`           | Project name or ID; falls back to setup context                                    |
| `version-id`        | no       | from setup     | `--version`           | Version name or ID; falls back to setup context                                    |
| `folder`            | no       | —              | `--folder`            | Folder name or ID, includes subfolders                                             |
| `component`         | no       | —              | `--component`         | Required by Component Impact and Component Remediation Package                     |
| `baseline-version`  | no       | —              | `--baseline-version`  | Version Comparison / Security Progress                                             |
| `current-version`   | no       | —              | `--current-version`   | Version Comparison / Security Progress                                             |
| `left`              | no       | —              | `--left`              | Comparison scope ref, e.g. `project:BN85@v3.2.1`. Switches to `fs-report compare`  |
| `right`             | no       | —              | `--right`             | Comparison scope ref. Required whenever `left` is set                              |
| `data-file`         | no       | —              | `--data-file`         | forge `exploitability-dataset/v2` export, for the Exploitability Report recipes    |
| `period`            | no       | —              | `--period`            | Time period, e.g. `30d`, `1m`                                                      |
| `cve`               | no       | —              | `--cve`               | CVE ID(s); required by CVE Impact                                                  |
| `finding-types`     | no       | `cve` (CLI)    | `--finding-types`     | `cve`, `sast`, `thirdparty`, `all`, or comma-separated                             |
| `open-only`         | no       | `true`         | `--open-only`         | Security Progress only. The CLI default is `false`; this action defaults to `true` |
| `scoring-file`      | no       | —              | `--scoring-file`      | Custom gate/scoring YAML for Triage Prioritization                                 |
| `ai`                | no       | `false`        | `--ai`                | Enable AI analysis (requires an AI provider key in the job env)                    |
| `ai-prompts`        | no       | `false`        | `--ai-prompts`        | Generate AI prompts without calling the AI API                                     |
| `output-dir`        | no       | `./fs-reports` | `--output`            | Output directory                                                                   |
| `fs-report-version` | no       | latest         | —                     | pipx version spec, e.g. `==2.0.4`                                                  |
| `cache-ttl`         | no       | `1`            | `--cache-ttl`         | Bare numbers are **hours**; also accepts `30m`, `1h30m`, `1d`                      |
| `extra-args`        | no       | —              | —                     | Whitespace-split passthrough for any other fs-report flag                          |

Anything not listed above — `--min-severity`, `--scan-type`, `--scan-status`, `--exploit-maturity`, `--include-status`, `--reachable-only`, `--top`, `--triage`, `--theme`, `--logo`, `--standalone` — goes through `extra-args`. It is split on whitespace, so values containing spaces must be quoted at the fs-report level or avoided.

**Outputs:**

| Output           | Description                                             |
| ---------------- | ------------------------------------------------------- |
| `report-dir`     | Path to generated reports directory                     |
| `artifact-name`  | Uploaded workflow artifact name                         |
| `summary-json`   | JSON string with key metrics extracted from reports     |
| `critical-count` | Triage Prioritization CRITICAL band, reported as P0     |
| `high-count`     | Triage Prioritization HIGH band, reported as P1         |
| `new-findings`   | New findings, from the Version Comparison churn table   |
| `fixed-findings` | Fixed findings, from the Version Comparison churn table |

**Behavior:** Installs `fs-report` via `pipx install --force` (no caching — the install runs every time). Passes auth to the CLI as `FINITE_STATE_AUTH_TOKEN` / `FINITE_STATE_DOMAIN` in the child env, never in argv. Runs `fs-report run --headless`, or `fs-report compare` when `left`/`right` are set. Always uploads the whole output directory as a workflow artifact, even when nothing parseable was produced.

**Output layout.** `fs-report` writes one directory per recipe, named after the recipe, with files sharing that base name:

```
fs-reports/
  Triage Prioritization/
    Triage Prioritization.csv          <- parsed into triageBands
    Triage Prioritization.html
    vex_recommendations.json
  Version Comparison/
    Version Comparison.csv             <- per-version summary table
    Version Comparison_Detail_Findings_Churn.csv   <- parsed into versionDelta
  Findings by Project/
    Findings by Project.csv            <- parsed into severityCounts
```

Only those three CSVs feed `summary-json`. Every other recipe still lands in the artifact but contributes nothing to the outputs or to `quality-gate`, so gate a run on a recipe that actually produces one of them. `fs-report` writes no aggregate summary file.

**Available recipes.** `fs-report list recipes` is authoritative; the catalog below is the full bundled set as of fs-report 2.0.x. "Needs" is the action input that must be set, over and above the project/version that `setup` already exports.

| Recipe                            | Needs            | CSV | Notes                                                         |
| --------------------------------- | ---------------- | --- | ------------------------------------------------------------- |
| Executive Summary                 | —                | yes | Portfolio posture overview, PDF-capable                       |
| Executive Dashboard               | —                | yes | KPI dashboard + `_Top_Risk_Products.csv`                      |
| Findings by Project               | —                | yes | Full findings inventory — the `severityCounts` source         |
| Triage Prioritization             | —                | yes | Banded findings + `vex_recommendations.json`                  |
| Version Comparison                | —                | yes | Progression, findings churn, component churn                  |
| Security Progress                 | —                | yes | Version-over-version resolved/introduced; honours `open-only` |
| Remediation Package               | project/`folder` | yes | Component action cards with upgrade paths                     |
| Component List                    | —                | yes | SBOM component inventory                                      |
| Component Vulnerability Analysis  | —                | yes | Components ranked by composite risk                           |
| License Report                    | —                | yes | License posture + `_Detail.csv`                               |
| Configuration Analysis Triage     | —                | yes | Config/credential/crypto findings                             |
| False Positive Analysis           | —                | yes | Mechanical checks; richer with `ai: true`                     |
| Reachability VEX Coverage         | —                | yes | Reachability vs VEX coverage gaps                             |
| CRA Compliance                    | —                | yes | EU CRA triage queue; `--exploit-maturity` via `extra-args`    |
| Scan Analysis                     | —                | yes | Scan throughput, durations, failures                          |
| Scan Quality                      | —                | yes | Coverage gaps, staleness + `_Detail.csv`                      |
| Platform Usage                    | —                | yes | Multi-table: projects, folders, versions, hygiene             |
| User Activity                     | —                | yes | Login/activity from the audit trail                           |
| CVE Impact                        | `cve`            | yes | Per-CVE dossier across the portfolio                          |
| CVE Component Evidence            | project          | yes | CVE-bearing components + firmware file paths                  |
| Human Readable SBOM               | project          | yes | Reviewer-facing SBOM                                          |
| Component Impact                  | `component`      | yes | Portfolio blast radius for one component                      |
| Component Remediation Package     | `component`      | yes | Zero-day upgrade guidance, no CVE required                    |
| Exploitability Report             | `data-file`      | no  | HTML/PDF from a forge `exploitability-dataset/v2` export      |
| Exploitability Report (Shareable) | `data-file`      | no  | Redacted external variant of the above                        |
| Component Diff                    | `left`+`right`   | no  | Comparison — runs via `fs-report compare`, HTML only          |
| Finding Diff                      | `left`+`right`   | no  | Comparison — fix-sync view                                    |
| License Diff                      | `left`+`right`   | no  | Comparison — copyleft deltas                                  |
| Triage Status Diff                | `left`+`right`   | no  | Comparison — diverging VEX decisions                          |

Seven further recipes ship under `fs_report/recipes/forge/` (Assessment Overview, Customer Brief, Customer Brief Detailed, Workflow Summary, and three JSON notification recipes). They are driven by finite-state-forge and are not intended to be called from CI.

**Comparison recipes are a different subcommand.** `fs-report run` rejects them outright — the engine only dispatches them inside a meta-compare bundle. Setting `left` and `right` makes the action call `fs-report compare` instead, which accepts only `--left`, `--right`, `--finding-types` and `--output`; `period`, `cache-ttl`, `ai`, `scoring-file` and the scope inputs are all ignored in that mode.

**Examples:**

```yaml
# Triage Prioritization with custom scoring
- uses: FiniteStateInc/finite-state-actions/actions/run-report@v2
  id: triage
  with:
    recipe: 'Triage Prioritization'
    period: 30d
    scoring-file: .github/fs-scoring.yaml

# Multiple recipes in one run
- uses: FiniteStateInc/finite-state-actions/actions/run-report@v2
  id: report
  with:
    recipe: 'Triage Prioritization,Version Comparison,Remediation Package'
    period: 30d
    ai: true

# Zero-day triage for a named component, portfolio-wide
- uses: FiniteStateInc/finite-state-actions/actions/run-report@v2
  with:
    recipe: 'Component Impact,Component Remediation Package'
    component: openssl

# CVE dossier across every project
- uses: FiniteStateInc/finite-state-actions/actions/run-report@v2
  with:
    recipe: 'CVE Impact'
    cve: CVE-2024-3094

# Comparison report — runs `fs-report compare`
- uses: FiniteStateInc/finite-state-actions/actions/run-report@v2
  with:
    recipe: 'Component Diff,License Diff'
    left: 'project:BN85@v3.2.1'
    right: 'project:BN85@v3.3.0'

# A flag with no dedicated input
- uses: FiniteStateInc/finite-state-actions/actions/run-report@v2
  with:
    recipe: 'Findings by Project'
    folder: Gateways
    extra-args: '--min-severity HIGH --scan-type SCA --reachable-only'
```

---

### quality-gate

Consumes outputs from `run-report` to pass/fail the workflow. Supports three gating modes that can be combined (AND'd).

**Usage:** `FiniteStateInc/finite-state-actions/actions/quality-gate@v2`

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

| Input        | Default | Description                              |
| ------------ | ------- | ---------------------------------------- |
| `fail-on-p0` | `true`  | Fail if any P0 (CRITICAL band) findings  |
| `fail-on-p1` | `false` | Fail if any P1 (HIGH band) findings      |
| `max-p0`     | `0`     | Max allowed P0 findings                  |
| `max-p1`     | `-1`    | Max allowed P1 findings (-1 = unlimited) |
| `ai`         | `false` | Accepted and ignored — not implemented   |

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
- Remaining findings scored additively and banded into P2 (MEDIUM) / P3 (LOW)

Custom scoring weights can be provided via `scoring-file` in the upstream `run-report` step.

The banding is fs-report's, not this action's: `quality-gate` reads bands out of `Triage Prioritization.csv`, where `run-report` maps `CRITICAL/HIGH/MEDIUM/LOW` onto `P0/P1/P2/P3`. `INFO` has no P-band equivalent and is dropped, so `INFO` findings are never gateable. A `--scoring-file` that names its bands `P0`–`P3` directly passes through unchanged.

**Example:**

```yaml
- uses: FiniteStateInc/finite-state-actions/actions/quality-gate@v2
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

**Usage:** `FiniteStateInc/finite-state-actions/actions/pr-comment@v2`

**Inputs:**

| Input              | Required | Default         | Description                                       |
| ------------------ | -------- | --------------- | ------------------------------------------------- |
| `report-dir`       | no       | from run-report | Path to fs-report output                          |
| `summary-json`     | no       | from run-report | Direct JSON from run-report outputs               |
| `template`         | no       | `summary`       | `summary`, `triage`, or `comparison` (see below)  |
| `custom-template`  | no       | —               | Accepted and ignored — not implemented            |
| `gate-result`      | no       | —               | Pass/fail from quality-gate to include in comment |
| `gate-summary`     | no       | —               | Gate evaluation summary text                      |
| `comment-tag`      | no       | `finite-state`  | Unique tag for edit-in-place                      |
| `collapse-details` | no       | `true`          | Accepted and ignored — not implemented            |

**Built-in templates:**

| Template     | Content                                                                        |
| ------------ | ------------------------------------------------------------------------------ |
| `summary`    | Compact severity overview with gate status and report artifact links           |
| `triage`     | P0/P1/P2/P3 band counts, gate status per band, top P0/P1 findings listed       |
| `comparison` | Version delta table (baseline vs current), new/fixed findings, component churn |

Those three renderers are all that exist. `detailed` and `custom` are accepted but fall through to `summary`, and the action carries no templating engine — `custom-template` is never read, and nothing is wrapped in `<details>`.

**Outputs:**

| Output        | Description                |
| ------------- | -------------------------- |
| `comment-id`  | The PR comment ID          |
| `comment-url` | Direct link to the comment |

**Behavior:** Reads report data from run-report outputs. Renders selected template with report data + gate results. Searches for existing PR comment by `comment-tag` marker. Creates or updates the comment (edit-in-place). Links to uploaded report artifacts.

**Example:**

```yaml
- uses: FiniteStateInc/finite-state-actions/actions/pr-comment@v2
  if: always()
  with:
    template: triage
    gate-result: ${{ steps.gate.outputs.result }}
    gate-summary: ${{ steps.gate.outputs.summary }}
    report-dir: ${{ steps.report.outputs.report-dir }}
```

**Important:** Always use `if: always()` so the comment is posted even when the quality gate fails.

---

### wait

Blocks until the platform finishes scanning a version, so a later step never reads partial results.

**Usage:** `FiniteStateInc/finite-state-actions/actions/wait@v2`

**Inputs:**

| Input        | Required | Default                   | Description                                                                            |
| ------------ | -------- | ------------------------- | -------------------------------------------------------------------------------------- |
| `api-token`  | no       | from setup/scan/upload    | FS API token. Only needed when none of those ran in this job                           |
| `domain`     | no       | from setup                | Platform domain. Falls back to the setup context, then `app.finitestate.io`            |
| `version-id` | no       | `FINITE_STATE_VERSION_ID` | Version to wait on. `scan` and `upload` export one; `setup` only if given `version-id` |
| `timeout`    | no       | fs-cli's 30 minutes       | Maximum wait in whole seconds, rounded up to whole minutes — all fs-cli's flag accepts |

**Outputs:** none. The step passes or fails; there is no partial-success status to report.

**Behavior:** A bundled `node24` action like the rest. It runs `fs-cli query --type scan --format json --endpoint https://<domain> --version-id <id> --wait --fail-on-scan-incomplete`, the same call `upload` makes under `wait-for-completion`. `--wait` makes fs-cli poll; `--fail-on-scan-incomplete` fails the step on a failed scan, a poll timeout, or a version with no scans at all. The token goes through `FS_TOKEN`, never on the command line. fs-cli is invoked with an argument list and no shell, so it behaves the same on ubuntu, macOS and Windows runners — this action was a bash composite through v2.0, which on Windows meant Git Bash.

**Example:**

```yaml
- uses: FiniteStateInc/finite-state-actions/actions/scan@v2
  with:
    api-token: ${{ secrets.FINITE_STATE_AUTH_TOKEN }}
    domain: ${{ vars.FINITE_STATE_DOMAIN }}
    project-name: ${{ github.event.repository.name }}
    version: ${{ github.ref_name }}

- uses: FiniteStateInc/finite-state-actions/actions/wait@v2
  with:
    timeout: 3600 # optional; unset leaves fs-cli its 30-minute default
```

**Gotchas:**

- **It reuses the fs-cli an earlier step installed, and downloads one when there is none.** `setup`, `scan` or `upload` earlier in the job is the normal case, but `wait` with an `api-token` and a `version-id` works as the only Finite State step in a job. Two consequences on a locked-down self-hosted runner: as the first Finite State step it needs egress to the platform's CLI endpoint, and it resolves the runner's OS and architecture before looking at `PATH`, so a runner with no fs-cli build (anything outside linux/darwin/windows on amd64/arm64) now fails even with a working fs-cli installed — through v2.0 the shell version ran whatever `command -v fs-cli` found. `scan` and `upload` have always behaved this way.
- **`version-id` is a platform version ID, not a label.** It defaults to `FINITE_STATE_VERSION_ID`, which `scan` and `upload` export after reading it back from fs-cli. When `scan` could not parse an ID it warns, and `wait` then fails with `No version to wait on`.
- **It assumes a scan row exists for the version.** `--fail-on-scan-incomplete` counts "no scans at all" as a failure, and `scan`/`upload` returning only proves the _version_ was created — the wait relies on fs-cli's `--wait` tolerating the window before the platform records a scan against it. `upload --wait-for-completion` makes the identical call and has shipped since v2, so this is the same assumption in a separate step. An immediate no-scans failure is the symptom if that window is ever real.
- **Redundant after `upload` with `wait-for-completion: true`.** That input runs the same query inside the upload step. Use one or the other, not both.
- **It waits on one version.** Two uploads to different versions in the same job need a `wait` step each, with `version-id` set explicitly — the env var only holds the most recent.
- **`setup` alone does not satisfy it.** `setup` exports `FINITE_STATE_VERSION_ID` only when you passed it a `version-id`, so `setup` → `wait` fails with `No version to wait on` unless a `scan` or `upload` ran between them or you pass `version-id` yourself.
- **`timeout` is per step.** `upload`'s `timeout` bounds its own upload and its own poll under `wait-for-completion`; it does not carry into a separate `wait` step, which falls back to fs-cli's 30-minute default unless given its own `timeout`.
- **It reports pass/fail, not status.** `upload` publishes `scan-status` because it parses the query JSON; `wait` takes fs-cli's exit code as the verdict — under `--fail-on-scan-incomplete` a zero exit means every scan settled — and reads no JSON, so there is no status output to consume. Use `upload` with `wait-for-completion: true` when a downstream step needs the status string.
- **It validates the fs-cli it finds on `PATH`.** Like `scan` and `upload` it goes through `ensureFsCli`, which resolves the runner's OS and architecture first, sniffs the executable header of the fs-cli on `PATH`, and downloads a correct one when that header is for another platform.

---

### download-sbom

Exports the FS-generated SBOM back into the workflow as a file and/or artifact.

**Usage:** `FiniteStateInc/finite-state-actions/actions/download-sbom@v2`

**Inputs:**

| Input             | Required | Default             | Description                                                                                                   |
| ----------------- | -------- | ------------------- | ------------------------------------------------------------------------------------------------------------- |
| `api-token`       | no       | from setup          | FS API token. Required only when `setup`/`scan`/`upload` did not run                                          |
| `domain`          | no       | from setup          | Platform domain. Falls back to setup context, then `app.finitestate.io`                                       |
| `version-id`      | no       | from setup/upload   | Falls back to setup context or upload output. Skips the name lookups; outranks `project-name`/`version`       |
| `project-id`      | no       | from setup          | Project UUID. Used with `version` when no version ID is known; skips the name lookup, outranks `project-name` |
| `project-name`    | no       | from setup          | Project name, resolved by fs-cli. Used with `version` when no ID is known                                     |
| `version`         | no       | —                   | Version label, resolved by fs-cli. Needs a project (input or inherited). Beats an _inherited_ version ID      |
| `format`          | no       | `cyclonedx`         | `cyclonedx` (alias `cdx`) or `spdx`, case-insensitive. An unrecognized value fails the step                   |
| `max-size`        | no       | fs-cli's 64 (MiB)   | Reject an SBOM larger than this many MiB. Raise it for a version whose SBOM exceeds 64 MiB                    |
| `include-vex`     | no       | `true`              | Include VEX triage data in SBOM                                                                               |
| `output-file`     | no       | `sbom.json`         | Output file path                                                                                              |
| `upload-artifact` | no       | `true`              | Upload as workflow artifact                                                                                   |
| `artifact-name`   | no       | `finite-state-sbom` | Artifact name                                                                                                 |

**Outputs:**

| Output            | Description                                                                                                                                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `file`            | Path to the downloaded SBOM file                                                                                                                                                                                                                                    |
| `artifact-name`   | Artifact name — set even when `upload-artifact` is `false`                                                                                                                                                                                                          |
| `component-count` | CycloneDX `components` or SPDX `packages` count. Not comparable across formats — SPDX usually counts the describing package, CycloneDX omits `metadata.component` and nested components. `0` with a warning when the file cannot be parsed or carries neither array |

**Behavior:** Runs `fs-cli export --format <format> --include-vex=<bool> --output-file <path> --overwrite` (plus `--max-size` when that input is set), going through `ensureFsCli` like `scan`, `upload` and `wait` — so it reuses an fs-cli an earlier step put on `PATH` and installs one when this is the first Finite State step in the job. fs-cli writes the document byte for byte, so the file keeps the formatting the platform produced rather than a re-serialised copy. The token is passed via `FS_TOKEN`, never on the command line. Auth comes from `api-token`/`domain` when given, otherwise from the env vars `setup`, `scan` or `upload` exported. Optionally uploads the file as a workflow artifact. The only REST call the action makes is the fs-cli download when the binary is not already on `PATH`.

**Example:**

```yaml
- uses: FiniteStateInc/finite-state-actions/actions/download-sbom@v2
  with:
    format: cyclonedx
    include-vex: true
    output-file: sbom-with-vex.json
```

**Gotchas:**

- **`version-id` is a platform version ID, not a version label.** `v1.2.3` will not work; the ID is what `upload` returns as its `version-id` output. To export by label instead, pass `project-name` and `version` and let fs-cli resolve them — `version` is matched against the platform's version _name_ or _number_, the same as `query`.
- **Explicit inputs beat inherited context.** A `version-id` input is the most specific locator; a `version` label you pass beats a `FINITE_STATE_VERSION_ID` exported by an upstream `scan` or `upload`. The inherited ID is used only when you pass neither, which is what makes `scan` → `download-sbom` work with no inputs.
- **A very large SBOM needs `max-size` raised.** fs-cli rejects a response over 64 MiB by default, which the REST path this replaced did not do, so a version whose SBOM is bigger fails until you raise `max-size`. The number is in MiB.
- **`download-sbom` needs `fs-cli` from v2 on.** It exports through `fs-cli export` instead of the REST API, reusing an `fs-cli` an earlier step put on `PATH` and downloading one from `GET /cli/download` otherwise. On an egress-restricted runner that permits the API but not the binary download, install `fs-cli` yourself before this step — a genuine native build for that runner, since the actions check the executable header of anything on `PATH` and download a replacement when it does not match, so a shim or foreign build fails anyway.
- **An explicit project input beats an inherited project ID.** The two can name different projects, so when you pass `project-name` the action sends `--name` alone rather than letting fs-cli choose between them. `project-id` outranks `project-name` when both are given, because a UUID cannot be ambiguous.
- **A project input needs `version` to locate anything.** `project-name`/`project-id` on their own cannot identify a version, so if an upstream step exported a version ID the action exports that instead and warns that the project input was ignored — the inherited ID may belong to a different project. Pass `version` to export by label. With no inherited ID either, the step fails.
- **A `scan`-only workflow gets its version ID from `scan`.** `scan` reads the ID back from fs-cli's output and exports it, so `download-sbom` needs no `version-id` input after a `scan` in the same job. When fs-cli prints no ID (an interrupted scan, an older fs-cli), `scan` warns and you have to pass `version-id` yourself.
- **The scan has to finish first, and neither `scan` nor a default `upload` waits for it.** Both return once the platform accepts the files and analyse them in the background, so an export placed straight after either one returns a partial SBOM — typically no findings and no VEX data, with no error to tell you. After `upload`, set `wait-for-completion: true`. After `scan`, add the `wait` action, which needs no inputs.

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
  |       |-- exports: the same env vars, IDs read back from fs-cli output
  |       |-- outputs: exit-code, project-id, version-id
  |
  +---> upload (uploads binary/SBOM/third-party results)
  |       |-- exports: the same env vars, plus FINITE_STATE_VERSION_ID
  |       |-- outputs: version-id, project-id, scan-status
  |
  +---> wait (blocks until the platform finishes scanning the version)
  |       |-- reads: FINITE_STATE_AUTH_TOKEN, FINITE_STATE_DOMAIN, FINITE_STATE_VERSION_ID
  |       |-- installs fs-cli when no earlier step put one on PATH
  |       |-- outputs: none; fails the step on a failed or unfinished scan
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

1. **setup comes first when used** -- it provides auth context via env vars, and installs fs-cli. Every action except `scan`, `upload` and `download-sbom` requires it.
2. **upload before run-report** -- the scan must complete before reports can analyze it.
3. **run-report before quality-gate and pr-comment** -- both consume report outputs.
4. **quality-gate before pr-comment** (optional) -- if you want gate results in the PR comment, run the gate first.
5. **wait for the scan before download-sbom or run-report** -- `scan` and `upload` both return as soon as the upload is accepted. Use `wait-for-completion: true` on `upload`, or the `wait` action after `scan`.
6. **download-sbom needs a version ID, or a name/version pair** -- `scan` and `upload` both output the platform's version ID and export it as `FINITE_STATE_VERSION_ID`, so either earlier in the job covers it. Otherwise pass `version-id` to `setup` or to `download-sbom`, or pass `project-id`/`project-name` together with `version` and let fs-cli resolve the label.
7. **`scan`, `upload` and `download-sbom` run without setup** -- all three accept `api-token`/`domain` and `project-id`/`project-name` directly, and all three download fs-cli when PATH has none. The other actions read auth from the env vars `setup` exports, though all of them accept explicit project/version inputs instead of upstream outputs.
8. **`scan` and `upload` export the full context too** -- both write the same `FINITE_STATE_*` env vars `setup` does, including `FINITE_STATE_PROJECT_ID` and `FINITE_STATE_VERSION_ID`, so a later step inherits everything without repeating it. Both read those two IDs back from fs-cli's own output, which is the only place the platform reports them. No other action exports anything.

### Referencing upstream outputs

Use `steps.<step-id>.outputs.<output-name>`:

```yaml
- uses: FiniteStateInc/finite-state-actions/actions/setup@v2
  id: fs
  with:
    api-token: ${{ secrets.FINITE_STATE_AUTH_TOKEN }}

- uses: FiniteStateInc/finite-state-actions/actions/upload@v2
  id: scan
  with:
    type: sca
    file: build/firmware.bin

# Reference upload's version-id
- uses: FiniteStateInc/finite-state-actions/actions/run-report@v2
  id: report
  with:
    recipe: 'Triage Prioritization'
    version-id: ${{ steps.scan.outputs.version-id }}

# Reference run-report's outputs
- uses: FiniteStateInc/finite-state-actions/actions/quality-gate@v2
  id: gate
  with:
    mode: triage-priority
    report-dir: ${{ steps.report.outputs.report-dir }}

# Reference both report and gate outputs
- uses: FiniteStateInc/finite-state-actions/actions/pr-comment@v2
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

      - uses: FiniteStateInc/finite-state-actions/actions/scan@v2
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

      - uses: FiniteStateInc/finite-state-actions/actions/setup@v2
        with:
          api-token: ${{ secrets.FINITE_STATE_AUTH_TOKEN }}
          domain: ${{ vars.FINITE_STATE_DOMAIN }}
          project-id: ${{ vars.FINITE_STATE_PROJECT_ID }}

      - uses: FiniteStateInc/finite-state-actions/actions/upload@v2
        with:
          type: sca
          file: build/firmware.bin
          version: 'pr-${{ github.event.number }}'
          wait-for-completion: true

      - uses: FiniteStateInc/finite-state-actions/actions/run-report@v2
        id: report
        with:
          recipe: 'Triage Prioritization,Version Comparison'
          period: 30d

      - uses: FiniteStateInc/finite-state-actions/actions/quality-gate@v2
        id: gate
        with:
          mode: delta,triage-priority
          max-new-critical: 0
          fail-on-p0: true

      - uses: FiniteStateInc/finite-state-actions/actions/pr-comment@v2
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
      - uses: FiniteStateInc/finite-state-actions/actions/setup@v2
        with:
          api-token: ${{ secrets.FINITE_STATE_AUTH_TOKEN }}
          domain: ${{ vars.FINITE_STATE_DOMAIN }}
          project-id: ${{ vars.FINITE_STATE_PROJECT_ID }}

      - uses: FiniteStateInc/finite-state-actions/actions/run-report@v2
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

      - uses: FiniteStateInc/finite-state-actions/actions/setup@v2
        with:
          api-token: ${{ secrets.FINITE_STATE_AUTH_TOKEN }}
          domain: ${{ vars.FINITE_STATE_DOMAIN }}
          project-id: ${{ vars.FINITE_STATE_PROJECT_ID }}

      - uses: FiniteStateInc/finite-state-actions/actions/upload@v2
        id: scan
        with:
          type: sca
          file: build/firmware.bin
          version: '${{ github.ref_name }}'
          wait-for-completion: true

      - uses: FiniteStateInc/finite-state-actions/actions/download-sbom@v2
        with:
          version-id: ${{ steps.scan.outputs.version-id }}
          format: cyclonedx
          include-vex: true
          artifact-name: 'sbom-${{ github.ref_name }}'
```

A source scan works the same way, with no `version-id` anywhere — `scan` exports the ID it read back from fs-cli:

```yaml
- uses: FiniteStateInc/finite-state-actions/actions/scan@v2
  with:
    api-token: ${{ secrets.FINITE_STATE_AUTH_TOKEN }}
    domain: ${{ vars.FINITE_STATE_DOMAIN }}
    project-name: ${{ github.event.repository.name }}
    version: ${{ github.ref_name }}

- uses: FiniteStateInc/finite-state-actions/actions/wait@v2

- uses: FiniteStateInc/finite-state-actions/actions/download-sbom@v2
  with:
    format: cyclonedx
    include-vex: true
    artifact-name: 'sbom-${{ github.ref_name }}'
```

`scan` has no `wait-for-completion` input, so the `wait` action does the waiting. It needs
no inputs: `scan` puts `fs-cli` on `PATH` and exports `FINITE_STATE_AUTH_TOKEN`,
`FINITE_STATE_DOMAIN` and `FINITE_STATE_VERSION_ID` for later steps in the same job. Pass
`timeout` (whole seconds) to bound the wait; unset leaves fs-cli its 30-minute default.

**Key points:**

- Triggered on release for versioned SBOMs
- Version named after the release tag for traceability
- `include-vex: true` bundles triage decisions into the SBOM
- The export waits for the scan — `wait-for-completion: true` after `upload`, the `wait` action after `scan`. Without it the SBOM is whatever the platform had finished, usually with no findings and no VEX data
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
      - uses: FiniteStateInc/finite-state-actions/actions/setup@v2
        with:
          api-token: ${{ secrets.FINITE_STATE_AUTH_TOKEN }}
          domain: ${{ vars.FINITE_STATE_DOMAIN }}
          project-id: ${{ vars.FINITE_STATE_PROJECT_ID }}

      # 2. Upload and scan
      - uses: FiniteStateInc/finite-state-actions/actions/upload@v2
        id: scan
        with:
          type: sca
          file: build/firmware.bin
          version: 'pr-${{ github.event.number }}'
          wait-for-completion: true

      # 3. Generate reports (multiple recipes)
      - uses: FiniteStateInc/finite-state-actions/actions/run-report@v2
        id: report
        with:
          recipe: 'Triage Prioritization,Version Comparison,Remediation Package'
          period: 30d
          scoring-file: .github/fs-scoring.yaml
          ai: true

      # 4. Quality gate
      - uses: FiniteStateInc/finite-state-actions/actions/quality-gate@v2
        id: gate
        with:
          mode: delta,threshold,triage-priority
          max-new-critical: 0
          max-new-high: 0
          max-critical: 5
          fail-on-p0: true

      # 5. PR comment (always runs)
      - uses: FiniteStateInc/finite-state-actions/actions/pr-comment@v2
        if: always()
        with:
          template: triage
          gate-result: ${{ steps.gate.outputs.result }}
          gate-summary: ${{ steps.gate.outputs.summary }}
          report-dir: ${{ steps.report.outputs.report-dir }}

      # 6. Export SBOM
      - uses: FiniteStateInc/finite-state-actions/actions/download-sbom@v2
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

| Symptom                                 | Cause                              | Fix                                                                                                   |
| --------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `setup` fails with "401 Unauthorized"   | Invalid or expired API token       | Regenerate token in FS platform (Settings > API Tokens) and update `secrets.FINITE_STATE_AUTH_TOKEN`  |
| `setup` fails with "403 Forbidden"      | Token lacks required permissions   | Ensure token has read/write access to the target project                                              |
| Downstream action fails with auth error | `setup` step was not run or failed | Add `FiniteStateInc/finite-state-actions/actions/setup@v2` as the first step; check that it succeeded |
| Auth works locally but fails in CI      | Token stored incorrectly           | Verify the secret is set at the correct scope (repo or org) and the workflow has access               |

### Network and proxy failures

| Symptom                                                | Cause                                                           | Fix                                                                                                             |
| ------------------------------------------------------ | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `Could not install fs-cli from <domain>: fetch failed` | Runner cannot reach the platform: proxy, DNS, or blocked egress | Set `HTTPS_PROXY`/`NO_PROXY` on the job; allowlist the platform domain **and** the pre-signed storage host      |
| `setup` fails but a `scan` step with `api-token` works | `scan` reuses an fs-cli already on PATH, so it never downloads  | Same fix — `setup` always downloads, so it is the first step to hit an egress block                             |
| `FS_SKIP_UPDATE=1` does not skip the download          | That variable belongs to fs-cli; no action reads it             | There is no skip flag — fix the network path, or drop `setup` and set the `FINITE_STATE_*` variables on the job |

To find the second host, run the download endpoint by hand and read `download_url`:

```bash
curl -s -H "X-Authorization: $FS_TOKEN" \
  "https://app.finitestate.io/api/public/v0/cli/download?os=linux&arch=amd64"
```

### Scan timeouts

| Symptom                                                            | Cause                                                                                       | Fix                                                                                                                            |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `upload` fails with "Scan timed out"                               | Scan outran fs-cli's 30-minute default                                                      | Raise `timeout` (whole seconds, e.g. `3600`) or drop `wait-for-completion`                                                     |
| `scan-status` stays `RUNNING`                                      | Platform-side processing delay                                                              | Check the FS platform for scan status; retry if needed                                                                         |
| `upload` fails with "File not found"                               | Build artifact not available                                                                | Ensure the build step runs before upload; check the file path                                                                  |
| `wait` fails with "No version to wait on"                          | `scan` could not parse an ID, or no scan/upload ran                                         | Pass `version-id` explicitly; the `scan` step warns when it cannot read one                                                    |
| `wait` fails with "not available for this runner"                  | The runner's OS/arch has no fs-cli build, and `wait` resolves that before looking at `PATH` | Use a linux/darwin/windows runner on amd64 or arm64; through v2.0 `wait` would run whatever fs-cli was already on `PATH` there |
| `wait` fails downloading fs-cli, with no earlier Finite State step | `wait` installs fs-cli itself now, so it needs egress to the platform's CLI endpoint        | Run `setup`, `scan` or `upload` earlier in the job, or allow the runner to reach the domain                                    |
| `wait` warns "Ignoring the fs-cli on PATH" then downloads          | The fs-cli already on `PATH` was built for another OS or architecture                       | Nothing, unless the download is also blocked — then install a matching fs-cli                                                  |
| SBOM or report has no findings                                     | Exported before the platform finished scanning                                              | `wait-for-completion: true` on `upload`, or the `wait` action after `scan`                                                     |

### Source scan (fs-cli)

| Symptom                                            | Cause                                                     | Fix                                                                                         |
| -------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `FINITE_STATE_AUTH_TOKEN is not set`               | Neither `setup` ran nor `api-token` was passed to `scan`  | Add the `setup` action, or pass `api-token` directly to `scan`                              |
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

| Skill                 | Relationship                                                                                                                                                                                                                                             |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **fs-api**            | The REST API. Most work now goes through `fs-cli` instead: `setup` only calls `/cli/download` (plus a project-name lookup), and `scan`, `upload` and `download-sbom` only `/cli/download`. See fs-api for endpoint details, pagination, and error codes. |
| **fs-report-cli**     | The CLI tool that `run-report` wraps. All recipe execution, output formats, and scoring configuration are fs-report features. See fs-report-cli for CLI flags, output structure, and caching.                                                            |
| **fs-report-recipes** | The recipe catalog available in `run-report`. Each recipe has specific inputs, outputs, and use cases. See fs-report-recipes for recipe details, output files, and combination patterns.                                                                 |
| **fs-platform**       | Platform concepts (organizations, projects, versions, findings, VEX). Understanding the data model helps configure actions correctly. See fs-platform for hierarchy, finding lifecycle, and triage workflows.                                            |

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
