# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A pnpm workspace monorepo providing GitHub Actions for integrating Finite State firmware/software security analysis into CI/CD pipelines. The platform analyzes firmware/software for vulnerabilities (CVEs), generates SBOMs, and tracks VEX triage status.

## Commands

```bash
pnpm install          # Install all dependencies
pnpm build            # TypeScript compile all packages + ncc-bundle actions
pnpm test             # Run all tests (Vitest)
pnpm lint             # ESLint check
pnpm format           # Prettier format
pnpm typecheck        # TypeScript noEmit check
```

Run a single test file:

```bash
pnpm vitest run packages/core/__tests__/client.test.ts
```

Build a single action (from its directory):

```bash
cd actions/setup && pnpm build
```

Actions are bundled with `@vercel/ncc` into `dist/index.js` — these bundles are committed and must be up-to-date before merge (CI verifies this).

## Architecture

### Shared Core (`packages/core`)

`@finite-state/core` — imported by all actions via `workspace:*`.

- **client.ts** — `FsClient` wraps Finite State REST API. Retry logic: exponential backoff, 6 retries for 429/5xx. Non-retryable: 400/401/403/404/500.
- **context.ts** — Reads/writes `FINITE_STATE_AUTH_TOKEN`, `FINITE_STATE_DOMAIN`, `FS_PROJECT_ID`, `FS_VERSION_ID` environment variables via `@actions/core`. The `setup` action exports these; downstream actions read them.
- **models.ts** — Shared enums (`Severity`, `ScanType`, `GateMode`, `SbomFormat`, etc.) and interfaces (`Finding`, `GateResult`, `ReportSummary`, etc.).
- **gates.ts** — `evaluateGates()` — three modes: `delta`, `threshold`, `triage-priority`.
- **report-parser.ts** — Parses CSV output from `fs-report` tool (triage and version-delta formats).
- **formatting.ts** — Renders markdown for PR comments; supports edit-in-place via comment tags.

### Actions (`actions/*`)

Six GitHub Actions, each with `action.yml` + `src/main.ts` + `dist/index.js`:

| Action          | Purpose                                                                      |
| --------------- | ---------------------------------------------------------------------------- |
| `setup`         | Auth bootstrap — validates token, exports env vars for downstream steps      |
| `upload-scan`   | Upload firmware/SBOM files, optionally poll for scan completion              |
| `run-report`    | Install & execute `fs-report` CLI (via pipx), parse output, upload artifacts |
| `quality-gate`  | Evaluate findings against gate config, output pass/fail                      |
| `pr-comment`    | Post/update PR comment with findings summary and gate results                |
| `download-sbom` | Export CycloneDX/SPDX SBOM, upload as artifact                               |

Actions chain via environment variables (set by `setup`) and step outputs (JSON).

## Code Style

- TypeScript strict mode, target ES2022, CommonJS output
- Prettier: no semicolons, single quotes, trailing commas, 100 char width
- Unused variables prefixed with `_` are allowed
- Node.js >= 20
