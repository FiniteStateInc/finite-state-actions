# Finite State GitHub Actions

A collection of GitHub Actions for integrating [Finite State](https://finitestate.io) firmware and software security analysis into your CI/CD pipelines. Automate SBOM uploads, scan monitoring, report generation, quality gates, and pull request feedback — all from your workflows.

## Actions

| Action                                   | Description                                                                |
| ---------------------------------------- | -------------------------------------------------------------------------- |
| [setup](./actions/setup)                 | Authenticate with the Finite State platform, configure env, install fs-cli |
| [scan](./actions/scan)                   | Scan project dependencies with fs-cli and upload results (runs standalone) |
| [upload-scan](./actions/upload-scan)     | Upload a firmware or software artifact for security scanning               |
| [run-report](./actions/run-report)       | Generate security reports using fs-report                                  |
| [quality-gate](./actions/quality-gate)   | Fail the build if findings exceed configurable thresholds                  |
| [pr-comment](./actions/pr-comment)       | Post a findings summary as a pull request comment                          |
| [download-sbom](./actions/download-sbom) | Download the SBOM for a project version                                    |

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

      - uses: FiniteStateInc/finite-state-actions/actions/scan@v2
        with:
          version: ${{ github.ref_name }}

      - uses: FiniteStateInc/finite-state-actions/actions/download-sbom@v2
        with:
          format: cyclonedx
          include-vex: true
          artifact-name: 'sbom-${{ github.ref_name }}'
```

## Action chaining

Actions pass data via step outputs and environment variables. The `setup` action exports `FINITE_STATE_AUTH_TOKEN` and `FINITE_STATE_DOMAIN` as environment variables for the entire job.

`setup` is optional for `scan`, which accepts `api-token`/`domain`/`project-name` directly and installs `fs-cli` when it is not already on `PATH`. Every other action requires `setup`.

```
setup (validates auth, exports env vars, installs fs-cli)
  |
  +---> scan (runs fs-cli scan, uploads results to platform)
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
