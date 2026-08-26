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
pnpm format           # Prettier format (format:check in CI)
pnpm typecheck        # TypeScript noEmit check
```

**Build `packages/core` first in a fresh clone.** Actions import `@finite-state/core`, whose `main` points at `packages/core/dist` — which is gitignored. Until it exists, action `typecheck` and any non-mocked import fail:

```bash
pnpm -C packages/core run build
```

CI runs this explicitly before `typecheck` and `test`.

Run a single test file:

```bash
pnpm vitest run packages/core/__tests__/client.test.ts
```

Build a single action (from its directory):

```bash
cd actions/setup && pnpm build
```

## Architecture

### Shared Core (`packages/core`)

`@finite-state/core` — imported by all actions via `workspace:*`. Everything is re-exported from `src/index.ts`.

- **client.ts** — `FsClient` wraps Finite State REST API. Retry logic: exponential backoff (`2^attempt * 500ms`), 6 retries for 429/502/503/504. Non-retryable: 400/401/403/404/500. `resolveProjectId` throws `ProjectNotFoundError` on zero matches — `setup` catches that specifically and continues without an ID; an ambiguous name still fails hard.
- **context.ts** — Reads/writes `FINITE_STATE_AUTH_TOKEN`, `FINITE_STATE_DOMAIN`, `FINITE_STATE_PROJECT_ID`, `FINITE_STATE_PROJECT_NAME`, `FINITE_STATE_VERSION_ID` environment variables via `@actions/core`. The `setup` action calls `writeSetupContext()`; downstream actions call `readSetupContext()`.
- **models.ts** — Shared enums (`Severity`, `ScanType`, `GateMode`, `SbomFormat`, etc.) and interfaces (`Finding`, `GateResult`, `ReportSummary`, etc.).
- **client.ts / `authUserIdentity`** — `GET /authUser` returns `{ user, organization }`, not `{ email, organizationId }`. No action calls it any more: `setup` dropped the identity probe and now uses the authenticated `/cli/download` request as its token check. The client method and helpers stay for callers that want the identity — use the helpers, since reading `.email` directly is what made `setup` log `Authenticated as: undefined`.
- **install-cli.ts** — `installFsCli()` downloads fs-cli from `GET /cli/download?os=&arch=` into `$RUNNER_TEMP/fs-cli` and `core.addPath`s it; `ensureFsCli()` reuses an fs-cli already on `PATH` and installs only when absent. `setup` uses the former, `scan` and `upload` the latter. `process.platform`/`process.arch` map to the endpoint's `linux|darwin|windows` and `amd64|arm64`; anything else fails with a named error. Before the bytes are written, `assertBinaryMatchesRunner` reads the executable header (ELF `e_machine`, Mach-O `cputype`, PE `Machine`) and refuses a build for another OS or architecture — as well as a JSON/HTML error page served in place of the binary. A universal Mach-O is accepted, since it pins no single architecture. The endpoint also returns `version`, which is logged.
- **gates.ts** — `evaluateGates()` — three modes: `delta`, `threshold`, `triage-priority`.
- **report-parser.ts** — Parses CSV output from `fs-report` tool (triage and version-delta formats).
- **formatting.ts** — Renders markdown for PR comments; edit-in-place works by embedding an HTML comment tag the action greps for on re-run.

### Actions (`actions/*`)

Seven GitHub Actions, each with `action.yml` + `src/main.ts` + `tsconfig.json` + `__tests__/` + committed `dist/`:

| Action          | Purpose                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------- |
| `setup`         | Auth bootstrap — installs fs-cli (also the token check), resolves project name to ID, exports env |
| `scan`          | Run fs-cli dependency scan and upload results; works standalone via its own `api-token`           |
| `upload`        | Upload firmware/SBOM/third-party files via fs-cli, optionally poll scan status via fs-cli         |
| `run-report`    | Install & execute `fs-report` CLI (via pipx), parse output, upload artifacts                      |
| `quality-gate`  | Evaluate findings against gate config, output pass/fail                                           |
| `pr-comment`    | Post/update PR comment with findings summary and gate results                                     |
| `download-sbom` | Export CycloneDX/SPDX SBOM, upload as artifact                                                    |

Plus `actions/upload-scan/` — a deprecated alias for `upload`, kept for consumers pinned to the old path. It is `action.yml` only: a composite that warns and forwards to `.../actions/upload@v2`. No `package.json`, so pnpm's `actions/*` glob skips it and it needs no bundle. Remove it in v3.

Actions chain via environment variables (set by `setup`) and step outputs (JSON, e.g. `details-json`).

### External CLIs

Three actions shell out via `@actions/exec` rather than the REST API: `scan` and `upload` run `fs-cli` (`upload` uses `upload`/`import`/`third-party` plus `query --type scan` for status, and passes the token via `FS_TOKEN` so it stays out of argv), `run-report` installs and runs `fs-report` through `pipx`. `setup`, `scan`, and `upload` install `fs-cli` via shared core code (`packages/core/src/install-cli.ts`: `installFsCli` always downloads, `ensureFsCli` reuses an fs-cli already on `PATH`): it fetches a pre-signed URL from `GET /cli/download?os=&arch=`, writes the binary under `$RUNNER_TEMP/fs-cli`, and `core.addPath`s it — so `PATH` only carries fs-cli for later steps in the same job. Tests mock `@actions/exec`, `@actions/core`, and `@finite-state/core` with `vi.mock` — no network or subprocess in tests.

### Build & Release

- All seven actions declare `using: 'node24'`. Bundles are built by ncc, not transpiled per-runtime, so the runtime lives only in `action.yml`.
- Actions are bundled with `@vercel/ncc` into `dist/index.js`. **These bundles are committed** and CI fails the `build` job if `git diff actions/*/dist/` is non-empty — always run `pnpm build` and commit the bundle with any source change.
- Root `.gitignore` lists `dist/` and `*.js`. Existing action bundles are already tracked so the rule doesn't affect them, but a **new** action's `dist/` needs `git add -f`.
- Tagging `v*` runs CI, creates a GitHub Release, and force-moves the major tag (`v2`). Consumers pin `FiniteStateInc/finite-state-actions/actions/<name>@v2`, so a broken committed bundle ships immediately. The current major is `v2`; `v2` is also moved by hand when shipping fixes without a new semver tag.

### Adding or changing an action

Inputs and outputs are documented in three places that CI does not keep in sync — update all of them: the action's `action.yml`, `README.md`, and `.claude/skills/fs-github-actions/SKILL.md` (the skill is the customer-facing action catalog).

## Code Style

- TypeScript strict mode, target ES2022, CommonJS output
- Prettier: no semicolons, single quotes, trailing commas, 100 char width
- Unused variables prefixed with `_` are allowed
- Node.js >= 20 (CI runs 22)
- Action `tsconfig.json` files only `include` `src/**/*`, so `pnpm typecheck` does not cover test files
