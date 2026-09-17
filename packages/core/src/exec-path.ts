/**
 * Quotes a binary path for the first parameter of `@actions/exec`'s `exec`.
 *
 * `exec` runs that parameter through its own `argStringToArray` even when an
 * args array is passed, so a bare path splits on spaces: fs-cli at
 * `C:\Program Files\fs-cli\fs-cli.exe` is run as `C:\Program` with
 * `Files\fs-cli\fs-cli.exe` prepended to the arguments, and the step fails with
 * a spawn error naming a path nobody wrote. Quoting round-trips through that
 * parser — inside double quotes it keeps a single backslash as-is, and an
 * embedded quote has to arrive escaped.
 *
 * Shared by every action that runs a binary whose path it did not choose (one
 * under `RUNNER_TEMP`, or one found on `PATH`) so the quoting cannot be right
 * in one action and missing in the next.
 */
export function quoteExecPath(binary: string): string {
  return `"${binary.replace(/"/g, '\\"')}"`
}
