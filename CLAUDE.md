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

The `test` job is a matrix over `ubuntu-latest`, `macos-latest` and `windows-latest`. `lint`, `typecheck` and `build` stay on ubuntu — they produce identical results anywhere. Windows is the leg worth keeping: every action runs there, and nothing else checks it.

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
- **context.ts** — Trims every value it reads and treats a whitespace-only one as absent (`core.getInput` trims; an environment variable does not, so a token built from a `vars.` expression can carry a trailing newline). Reads/writes `FINITE_STATE_AUTH_TOKEN`, `FINITE_STATE_DOMAIN`, `FINITE_STATE_PROJECT_ID`, `FINITE_STATE_PROJECT_NAME`, `FINITE_STATE_VERSION_ID` environment variables via `@actions/core`. The `setup` action calls `writeSetupContext()`; downstream actions call `readSetupContext()`.
- **models.ts** — Shared enums (`Severity`, `ScanType`, `GateMode`, `SbomFormat`, etc.) and interfaces (`Finding`, `GateResult`, `ReportSummary`, etc.).
- **client.ts / `authUserIdentity`** — `GET /authUser` returns `{ user, organization }`, not `{ email, organizationId }`. No action calls it any more: `setup` dropped the identity probe and now uses the authenticated `/cli/download` request as its token check. The client method and helpers stay for callers that want the identity — use the helpers, since reading `.email` directly is what made `setup` log `Authenticated as: undefined`.
- **install-cli.ts** — `installFsCli()` downloads fs-cli from `GET /cli/download?os=&arch=` into `$RUNNER_TEMP/fs-cli` and `core.addPath`s it; `ensureFsCli()` reuses an fs-cli already on `PATH` and installs only when absent. `setup` uses the former, `scan`, `upload`, `wait` and `download-sbom` the latter. `process.platform`/`process.arch` map to the endpoint's `linux|darwin|windows` and `amd64|arm64`; anything else fails with a named error. Before the bytes are written, `assertBinaryMatchesRunner` reads the executable header (ELF `e_machine`, Mach-O `cputype`, PE `Machine`) and refuses a build for another OS or architecture — as well as a JSON/HTML error page served in place of the binary, a DOS stub with no PE signature, or a machine value the check does not recognise. Only a universal Mach-O may leave the architecture unverified. Note the Mach-O byte order: a native little-endian thin binary starts with the bytes `cf fa ed fe`, which read big-endian as `0xcffaedfe` — that branch reads `cputype` little-endian, and the byte-swapped magics read it big-endian. `ensureFsCli` resolves the runner target first (so an unsupported platform fails instead of reusing whatever is on `PATH`), then runs the same check (`binaryMismatchReason`) over the head of an fs-cli found on `PATH` and downloads a correct one when it does not match. The endpoint also returns `version`, which is logged.
- **proxy.ts** — `useEnvProxy()` installs an undici `EnvHttpProxyAgent` as the global dispatcher when `HTTPS_PROXY`/`HTTP_PROXY` (either case) is set, so `fetch` honours it; `NO_PROXY` is handled by the agent. Node only reads those variables itself when started with `NODE_USE_ENV_PROXY`, which an action cannot set for its own process. Called from the `FsClient` constructor — the one point every request in this package passes through, including the fs-cli download, which takes a client. Idempotent, logs the proxy with credentials stripped, and warns instead of throwing on a malformed URL. `undici` is a direct dependency pinned to the major matching the actions' Node runtime (node24 -> undici 7); it adds ~1.25 MB to every committed bundle.
- **exec-path.ts** — `quoteExecPath()` wraps a binary path for the first parameter of `@actions/exec`'s `exec`, which parses that parameter as a command line even when an args array is passed. Unquoted, an fs-cli under `C:\Program Files\...` (or any `RUNNER_TEMP` with a space) is run as `C:\Program` with the rest prepended to the arguments. Used by `scan`, `upload`, `wait` and `download-sbom` — the four actions that run a binary path they did not choose.
- **sbom-format.ts** — `normalizeSbomFormat()` maps an SBOM format input to fs-cli's `--format` token, accepting the `cdx` alias and any casing, and throwing a named error instead of letting a typo reach fs-cli. Shared by `upload` (`sbom-format`, which passes its own "leave it unset" hint) and `download-sbom` (`format`) so a spelling one accepts cannot be an opaque CLI error in the other.
- **gates.ts** — `evaluateGates()` — three modes: `delta`, `threshold`, `triage-priority`.
- **report-parser.ts** — Parses CSV output from `fs-report` tool (triage and version-delta formats).
- **formatting.ts** — Renders markdown for PR comments; edit-in-place works by embedding an HTML comment tag the action greps for on re-run.

### Actions (`actions/*`)

Eight bundled GitHub Actions, each with `action.yml` + `src/main.ts` + `tsconfig.json` + `__tests__/` + committed `dist/`:

| Action          | Purpose                                                                                                                                                                          |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setup`         | Auth bootstrap — installs fs-cli (also the token check), resolves project name to ID, exports env                                                                                |
| `scan`          | Run fs-cli dependency scan and upload results; works standalone via its own `api-token`, and exports the setup context, with project/version IDs parsed from fs-cli's log output |
| `upload`        | Upload firmware/SBOM/third-party files via fs-cli, optionally poll scan status via fs-cli; exports the setup context including the version ID                                    |
| `run-report`    | Install & execute `fs-report` CLI (via pipx), parse output, upload artifacts                                                                                                     |
| `quality-gate`  | Evaluate findings against gate config, output pass/fail                                                                                                                          |
| `pr-comment`    | Post/update PR comment with findings summary and gate results                                                                                                                    |
| `download-sbom` | Export CycloneDX/SPDX SBOM via `fs-cli export`, upload as artifact; takes `api-token`/`domain`/`project-id`/`project-name` when no setup ran                                     |
| `wait`          | Block until the platform finishes scanning a version, for the `scan` path, which has no `wait-for-completion` of its own                                                         |

`actions/wait/` was a bash composite through v2.0 and is now bundled like the rest. The rewrite was about Windows: a composite step declaring `shell: bash` runs under Git Bash there, and on a self-hosted Windows image without Git for Windows the step fails before the script runs, with GitHub's own error rather than one of ours. The Node action runs fs-cli through `@actions/exec` with an argument list and no shell, so one implementation covers ubuntu, macOS and Windows. It also goes through `ensureFsCli` now, like `scan` and `upload`, so it installs fs-cli when no earlier step did instead of failing. Deleted with the shell: `wait.sh`, `__tests__/action.test.sh`, the `wait-action` CI job, and the two bash traps that job existed to cover (an empty array expansion under `set -u` in the bash 3.2 macOS ships, and a leading zero read as octal). The `timeout` parsing those traps guarded now lives in `packages/core/src/timeout.ts` as `timeoutSecondsToMinutes`, shared with `upload` so the two cannot drift; it returns its rounding message instead of writing one, so each action titles its own annotation and core needs no logging channel. `wait` keeps the annotation titles and the exit code `wait.sh` published: `WaitFailure` in `actions/wait/src/main.ts` carries the title (`No API token`, `No version ID`, `Bad timeout`, `Scan did not finish`) and fs-cli's own exit code, because `core.setFailed` would drop the title and force exit 1.

Plus one composite action, which has no `package.json` — pnpm's `actions/*` glob skips it and it needs no bundle:

`actions/upload-scan/` — a deprecated alias for `upload`, kept for consumers pinned to the old path. It is `action.yml` only: a composite with one `uses:` step forwarding to `.../actions/upload@v2`, and no `run:` step, so it declares no shell and runs on Windows without Git for Windows like the rest. The deprecation warning rides on the required `type` input's `deprecationMessage`, which GitHub logs itself. No `package.json`, so pnpm's `actions/*` glob skips it and it needs no bundle. Remove it in v3.

Actions chain via environment variables (set by `setup`) and step outputs (JSON, e.g. `details-json`).

### External CLIs

Five actions shell out via `@actions/exec` rather than the REST API: `scan`, `upload`, `wait` and `download-sbom` run `fs-cli` (`upload` uses `upload`/`import`/`third-party` plus `query --type scan` for status, `wait` only the latter, `download-sbom` uses `export`, and those three pass the token via `FS_TOKEN` so it stays out of argv — `scan` still passes `--token` on the command line), `run-report` installs and runs `fs-report` through `pipx`. The four that run `fs-cli` pass its path through `quoteExecPath` (`packages/core/src/exec-path.ts`) first, because `exec` splits its first parameter on spaces; `run-report` runs `pipx` and `fs-report` by bare name, which has no space to split on. `setup`, `scan`, `upload`, `wait` and `download-sbom` install `fs-cli` via shared core code (`packages/core/src/install-cli.ts`: `installFsCli` always downloads, `ensureFsCli` reuses an fs-cli already on `PATH`): it fetches a pre-signed URL from `GET /cli/download?os=&arch=`, writes the binary under `$RUNNER_TEMP/fs-cli`, and `core.addPath`s it — so `PATH` only carries fs-cli for later steps in the same job. Tests mock `@actions/exec`, `@actions/core`, and `@finite-state/core` with `vi.mock` — no network or subprocess in tests.

### Build & Release

- All eight bundled actions declare `using: 'node24'`. Bundles are built by ncc, not transpiled per-runtime, so the runtime lives only in `action.yml`. The one remaining composite action (`upload-scan`) declares `using: 'composite'` and has no bundle.
- Actions are bundled with `@vercel/ncc` into `dist/index.js`. **These bundles are committed** and CI fails the `build` job if `git status --porcelain --ignored=matching actions/*/dist/` is non-empty — always run `pnpm build` and commit the bundle with any source change. It is `git status` rather than `git diff` because `dist/` is gitignored: a new action's bundle starts out untracked, and `git diff` reports nothing for a file git does not track, so a missing `dist/index.js` would ship with a green build.
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
