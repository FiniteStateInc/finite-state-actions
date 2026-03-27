# Finite State GitHub Actions

A collection of GitHub Actions for integrating [Finite State](https://finitestate.io) firmware and software security analysis into your CI/CD pipelines. Automate SBOM uploads, scan monitoring, report generation, quality gates, and pull request feedback — all from your workflows.

## Actions

| Action | Description |
|--------|-------------|
| [setup](./actions/setup) | Authenticate with the Finite State platform and configure the environment |
| [upload-scan](./actions/upload-scan) | Upload a firmware or software artifact for security scanning |
| [run-report](./actions/run-report) | Trigger a Finite State report for a project version |
| [quality-gate](./actions/quality-gate) | Fail the build if findings exceed configurable thresholds |
| [pr-comment](./actions/pr-comment) | Post a findings summary as a pull request comment |
| [download-sbom](./actions/download-sbom) | Download the SBOM for a project version |

## Quick Start

```yaml
name: Finite State Security Scan

on:
  push:
    branches: [main]
  pull_request:

jobs:
  security-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Finite State
        uses: finite-state-actions/setup@v1
        with:
          client-id: ${{ secrets.FINITE_STATE_CLIENT_ID }}
          client-secret: ${{ secrets.FINITE_STATE_CLIENT_SECRET }}
          organization-context: ${{ vars.FINITE_STATE_ORG_CONTEXT }}

      - name: Upload scan artifact
        uses: finite-state-actions/upload-scan@v1
        with:
          project-id: ${{ vars.FINITE_STATE_PROJECT_ID }}
          artifact-path: ./firmware.bin

      - name: Run security report
        uses: finite-state-actions/run-report@v1
        with:
          project-id: ${{ vars.FINITE_STATE_PROJECT_ID }}

      - name: Enforce quality gate
        uses: finite-state-actions/quality-gate@v1
        with:
          project-id: ${{ vars.FINITE_STATE_PROJECT_ID }}
          max-critical: 0
          max-high: 5

      - name: Post PR comment
        if: github.event_name == 'pull_request'
        uses: finite-state-actions/pr-comment@v1
        with:
          project-id: ${{ vars.FINITE_STATE_PROJECT_ID }}
```

## Setup

1. **Create an API token** — In the Finite State platform, navigate to Settings > API Tokens and create a new client credential pair (client ID and client secret).

2. **Add the secret** — In your GitHub repository, go to Settings > Secrets and variables > Actions and add:
   - `FINITE_STATE_CLIENT_ID` — your API client ID
   - `FINITE_STATE_CLIENT_SECRET` — your API client secret

3. **Add repository variables** — Under Settings > Secrets and variables > Actions > Variables, add:
   - `FINITE_STATE_ORG_CONTEXT` — your organization context ID
   - `FINITE_STATE_PROJECT_ID` — the project ID to scan against

4. **Copy the template** — Copy the Quick Start workflow above into `.github/workflows/finite-state.yml` in your repository and adjust the `artifact-path` and threshold values to match your project.

## License

MIT
