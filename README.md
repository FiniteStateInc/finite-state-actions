# Finite State GitHub Actions

A collection of GitHub Actions for integrating [Finite State](https://finitestate.io) firmware and software security analysis into your CI/CD pipelines. Automate SBOM uploads, scan monitoring, report generation, quality gates, and pull request feedback — all from your workflows.

## Actions

| Action                                   | Description                                                                        |
| ---------------------------------------- | ---------------------------------------------------------------------------------- |
| [setup](./actions/setup)                 | Authenticate with the Finite State platform, configure env, install fs-cli         |
| [scan](./actions/scan)                   | Scan project dependencies with fs-cli and upload results (runs standalone)         |
| [upload](./actions/upload)               | Upload a firmware, SBOM, or third-party scan file through fs-cli (standalone)      |
| [upload-scan](./actions/upload-scan)     | Deprecated alias for `upload`; forwards inputs and outputs, warns, removed in v3   |
| [wait](./actions/wait)                   | Wait for the platform to finish scanning a version                                 |
| [run-report](./actions/run-report)       | Generate security reports using fs-report                                          |
| [quality-gate](./actions/quality-gate)   | Fail the build if findings exceed configurable thresholds                          |
| [pr-comment](./actions/pr-comment)       | Post a findings summary as a pull request comment                                  |
| [download-sbom](./actions/download-sbom) | Export a version's CycloneDX/SPDX SBOM via fs-cli, upload as artifact (standalone) |

## Quick Start

### Prerequisites

1. **Finite State account** with API access enabled
2. **API token** generated from the FS platform (Settings > API Tokens)
3. **Project name or ID** for the target project. A name is enough — if no project matches, the platform creates one on the first scan. An existing project's ID is visible in the platform URL: `app.finitestate.io/projects/<id>`.

### Add secrets and variables

In your GitHub repository, go to Settings > Secrets and variables > Actions:

| Name                      | Type     | Where to find                                               |
| ------------------------- | -------- | ----------------------------------------------------------- |
| `FINITE_STATE_AUTH_TOKEN` | Secret   | FS platform > Settings > API Tokens > Generate              |
| `FINITE_STATE_DOMAIN`     | Variable | Your platform domain (e.g. `app.finitestate.io`)            |
| `FINITE_STATE_PROJECT_ID` | Variable | Project ID, or an exact project name for `setup` to resolve |

The domain must be the tenant the token was issued from (e.g. `acme.finitestate.io`, not `app.finitestate.io`) — a token used against the wrong tenant authenticates but sees no projects.

### Runners behind a proxy

Set `HTTPS_PROXY` (or `HTTP_PROXY`) and, if needed, `NO_PROXY` on the job. Every action
reads them and sends its platform requests through that proxy — including the fs-cli
download in `setup`. Lower-case `https_proxy`/`http_proxy` work too.

```yaml
jobs:
  security:
    runs-on: self-hosted
    env:
      HTTPS_PROXY: http://proxy.corp.example:3128
      NO_PROXY: localhost,127.0.0.1
```

Two hosts must be reachable through it: your platform domain (e.g. `app.finitestate.io`)
and the pre-signed object-storage host that domain hands back for the fs-cli binary.
A blocked host shows up as `Could not install fs-cli from <domain>: fetch failed`.

The proxy must allow `CONNECT` — the actions tunnel through it rather than sending
absolute-form requests. For a proxy that needs credentials, put them in the URL
(`http://user:pass@proxy.corp.example:3128`); the log line strips them.

### Usage

Since the actions live in a monorepo, reference them with the full path:

```
FiniteStateInc/finite-state-actions/actions/<action-name>@v2
```

### Source scan (single step)

`scan` runs on its own — it downloads `fs-cli` and authenticates from its own inputs. If the named project does not exist yet, the platform creates it:

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

### Source scan (with setup)

Add `setup` when more than one action runs in the job — it authenticates once, installs `fs-cli` once, and exports the context every downstream action reads:

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

      - uses: FiniteStateInc/finite-state-actions/actions/setup@v2
        with:
          api-token: ${{ secrets.FINITE_STATE_AUTH_TOKEN }}
          domain: ${{ vars.FINITE_STATE_DOMAIN }}
          project-id: ${{ vars.FINITE_STATE_PROJECT_ID }}

      - uses: FiniteStateInc/finite-state-actions/actions/scan@v2
        with:
          version: ${{ github.ref_name }}
```

You can also reference a project by name instead of ID. If no project matches the name, `setup` warns and continues — `fs-cli` creates the project on the first scan:

```yaml
- uses: FiniteStateInc/finite-state-actions/actions/setup@v2
  with:
    api-token: ${{ secrets.FINITE_STATE_AUTH_TOKEN }}
    project-name: MyProject
```

### PR gate with reports

Scan on every PR, generate a triage report, enforce a quality gate, and post results as a PR comment:

```yaml
name: Finite State PR Gate
on:
  pull_request:
    branches: [main]

jobs:
  security:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v6

      - uses: FiniteStateInc/finite-state-actions/actions/setup@v2
        with:
          api-token: ${{ secrets.FINITE_STATE_AUTH_TOKEN }}
          domain: ${{ vars.FINITE_STATE_DOMAIN }}
          project-id: ${{ vars.FINITE_STATE_PROJECT_ID }}

      - uses: FiniteStateInc/finite-state-actions/actions/scan@v2
        with:
          version: pr-${{ github.event.number }}

      - uses: FiniteStateInc/finite-state-actions/actions/wait@v2

      - uses: FiniteStateInc/finite-state-actions/actions/run-report@v2
        id: report
        with:
          recipe: 'Triage Prioritization'
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
          report-dir: ${{ steps.report.outputs.report-dir }}
```

### SBOM export on release

```yaml
name: SBOM Export
on:
  release:
    types: [published]

jobs:
  sbom:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6

      - uses: FiniteStateInc/finite-state-actions/actions/setup@v2
        with:
          api-token: ${{ secrets.FINITE_STATE_AUTH_TOKEN }}
          domain: ${{ vars.FINITE_STATE_DOMAIN }}
          project-id: ${{ vars.FINITE_STATE_PROJECT_ID }}

      - uses: FiniteStateInc/finite-state-actions/actions/upload@v2
        id: upload
        with:
          type: sca
          file: build/firmware.bin
          version: ${{ github.ref_name }}
          wait-for-completion: true

      - uses: FiniteStateInc/finite-state-actions/actions/download-sbom@v2
        with:
          version-id: ${{ steps.upload.outputs.version-id }}
          format: cyclonedx
          include-vex: true
          artifact-name: 'sbom-${{ github.ref_name }}'
```

`download-sbom` needs a version ID. `scan` and `upload` both output one and export it as
`FINITE_STATE_VERSION_ID`, so a `scan` or `upload` earlier in the job covers it. Otherwise
pass `version-id` to `setup` or to `download-sbom` yourself, or pass `project-name` and
`version` and let `fs-cli` resolve the label:

```yaml
- uses: FiniteStateInc/finite-state-actions/actions/download-sbom@v2
  with:
    api-token: ${{ secrets.FINITE_STATE_AUTH_TOKEN }}
    project-name: my-app
    version: v1.2.3
```

An explicit input always wins over inherited context: a `version-id` you pass is the most
specific locator, and a `version` label you pass beats a `FINITE_STATE_VERSION_ID` left by
an upstream `scan` or `upload`. The inherited ID applies only when you pass neither, which
is what lets `download-sbom` follow a `scan` with no inputs at all.

`download-sbom` runs `fs-cli export` rather than calling the REST API directly, so from v2
it needs `fs-cli`: it reuses one an earlier Finite State step put on `PATH`, and otherwise
downloads it from `GET /cli/download`. A job where `download-sbom` is the only Finite State
step therefore needs egress to that endpoint as well as to the API — if your runner allows
the API but blocks the binary download, put `fs-cli` on `PATH` yourself before this step.

### Wait for the scan before exporting

Both `scan` and `upload` return as soon as the platform accepts the files. The platform
then analyses them in the background. Export the SBOM straight after either step and you
get whatever the platform has finished so far — usually an SBOM with no findings and no
VEX data. Wait for the scan to settle first.

After `upload`, set `wait-for-completion: true` (as above) and the action polls for you.
That changes what the step costs: it now blocks for as long as the scan takes — up to
fs-cli's 30-minute default — and fails on a scan that fails or outruns the timeout, where
before it returned in seconds and reported `SUBMITTED`.

After `scan`, which has no such input, add the `wait` action. It needs no inputs — `scan`
exports the token, domain and version ID, and puts `fs-cli` on `PATH` for it to reuse:

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

`wait` fails the step on a failed scan, a poll timeout, or a version with no scans at all,
so a later step never reads partial results from a green job.

| Input        | Required | Default                      | Description                                                                 |
| ------------ | -------- | ---------------------------- | --------------------------------------------------------------------------- |
| `api-token`  | no       | from setup/scan/upload       | Only needed when none of those ran in this job                              |
| `domain`     | no       | from setup, then the default | Platform domain                                                             |
| `version-id` | no       | `FINITE_STATE_VERSION_ID`    | The version to wait on                                                      |
| `timeout`    | no       | fs-cli's own 30 minutes      | Maximum wait in whole seconds, rounded up to the whole minutes fs-cli takes |

Four things to know:

- **It reuses the `fs-cli` an earlier step installed, and downloads one when there is
  none.** So `setup`, `scan` or `upload` earlier in the job is the normal case, but `wait`
  with an `api-token` and a `version-id` works as the only Finite State step in a job.
- **`FINITE_STATE_VERSION_ID` comes from `scan` or `upload`.** `setup` exports it only when
  you passed it `version-id`, so `setup` → `wait` on its own has no version to wait on.
- **It waits on one version.** Two uploads to different versions in the same job need a
  `wait` each, with `version-id` set — the environment variable only holds the most recent.
- **`timeout` bounds this step only.** `upload`'s `timeout` covers its own upload and, with
  `wait-for-completion`, its own poll; it does not carry over to a separate `wait` step.

One assumption worth naming: `wait` asks the platform for the version's _scans_, and
`--fail-on-scan-incomplete` treats a version with no scans at all as a failure. `scan` and
`upload` return once the platform has accepted the files and reported the version ID, which
proves the version exists — not that a scan row has been recorded against it yet. The wait
therefore relies on fs-cli's `--wait` tolerating that window. `upload` has shipped with
`wait-for-completion` making the identical call since v2, so this is the same behaviour in a
separate step rather than a new risk. If you do see `wait` fail immediately with a
no-scans error, that window is the thing to suspect.

## Reports

`run-report` wraps the `fs-report` CLI. `fs-report list recipes` prints the authoritative catalog; these are the ones worth reaching for from CI, with the extra `run-report` input each one needs on top of the project/version `setup` already exports.

| Recipe                                                                 | Extra input needed  | Feeds `quality-gate` |
| ---------------------------------------------------------------------- | ------------------- | -------------------- |
| Triage Prioritization                                                  | —                   | yes                  |
| Version Comparison                                                     | —                   | yes                  |
| Findings by Project                                                    | —                   | yes                  |
| Executive Summary, Executive Dashboard                                 | —                   | no                   |
| Security Progress, Scan Analysis, Scan Quality, Platform Usage         | —                   | no                   |
| Component List, Component Vulnerability Analysis, License Report       | —                   | no                   |
| Configuration Analysis Triage, False Positive Analysis, CRA Compliance | —                   | no                   |
| Reachability VEX Coverage, User Activity                               | —                   | no                   |
| Remediation Package                                                    | project or `folder` | no                   |
| CVE Component Evidence, Human Readable SBOM                            | project             | no                   |
| CVE Impact                                                             | `cve`               | no                   |
| Component Impact, Component Remediation Package                        | `component`         | no                   |
| Exploitability Report, Exploitability Report (Shareable)               | `data-file`         | no                   |
| Component Diff, Finding Diff, License Diff, Triage Status Diff         | `left` + `right`    | no                   |

Two things to know:

- **Only three recipes populate the step outputs.** `summary-json`, `critical-count`, `high-count`, `new-findings` and `fixed-findings` are parsed from `Triage Prioritization.csv`, `Version Comparison_Detail_Findings_Churn.csv` and `Findings by Project.csv`. Every other recipe still lands in the uploaded artifact, but gating on one of them will always see zeroes.
- **The diff recipes use a different subcommand.** `fs-report run` refuses them. Setting `left` and `right` makes the action call `fs-report compare` instead, which ignores `period`, `cache-ttl`, `ai`, `scoring-file` and the scope inputs.

Any fs-report flag without a dedicated input — `--min-severity`, `--scan-type`, `--exploit-maturity`, `--top`, `--theme` — goes through `extra-args`:

```yaml
- uses: FiniteStateInc/finite-state-actions/actions/run-report@v2
  with:
    recipe: 'Findings by Project'
    folder: Gateways
    extra-args: '--min-severity HIGH --scan-type SCA --reachable-only'
```

## Action chaining

Actions pass data via step outputs and environment variables. The `setup` action exports `FINITE_STATE_AUTH_TOKEN` and `FINITE_STATE_DOMAIN` as environment variables for the entire job.

`setup` is optional for `scan`, `upload` and `download-sbom`, which accept `api-token`/`domain`/`project-id`/`project-name` directly and install `fs-cli` when it is not already on `PATH`. Every other action requires `setup`.

`scan` and `upload` also export that context themselves, so a later step inherits the token and domain without repeating them — the same environment variables `setup` writes. Both read the project and version IDs back from fs-cli's output and export those too, as `FINITE_STATE_PROJECT_ID` and `FINITE_STATE_VERSION_ID` plus matching step outputs. That is what lets `download-sbom` follow a `scan` with no inputs of its own.

```
setup (validates auth, exports env vars, installs fs-cli)
  |
  +---> scan (runs fs-cli scan, uploads results to platform)
  |
  +---> upload (runs fs-cli upload/import/third-party for a built artifact)
  |
  +---> wait (blocks until the platform finishes scanning the version)
  |       needed before anything below reads results — unless upload ran
  |       with wait-for-completion: true, which does the same waiting
  |
  +---> run-report (generates findings reports)
  |       |
  |       +---> quality-gate (pass/fail based on findings)
  |       |
  |       +---> pr-comment (posts results to PR)
  |
  +---> download-sbom (exports SBOM with VEX data)
```

Reference upstream outputs with `${{ steps.<step-id>.outputs.<output> }}`.

## License

MIT
