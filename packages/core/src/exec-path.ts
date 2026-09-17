/**
 * Quotes a binary path for the first parameter of `@actions/exec`'s `exec`.
 *
 * `exec` runs that parameter through its own `argStringToArray` even when an
 * args array is passed, so a bare path splits on spaces: fs-cli at
 * `C:\Program Files\fs-cli\fs-cli.exe` is run as `C:\Program` with
 * `Files\fs-cli\fs-cli.exe` prepended to the arguments, and the step fails with
 * a spawn error naming a path nobody wrote.
 *
 * Inside double quotes that parser keeps a lone backslash as-is, treats `\\` as
 * one backslash, and `\"` as a literal quote — so only a backslash run at the
 * end of the path (which would otherwise escape the closing quote) and an
 * embedded quote need escaping.
 *
 * Shared by every action that runs a binary whose path it did not choose (one
 * under `RUNNER_TEMP`, or one found on `PATH`) so the quoting cannot be right
 * in one action and missing in the next.
 */
export function quoteExecPath(binary: string): string {
  const escaped = binary
    .replace(/"/g, '\\"')
    // Doubled so the closing quote is not escaped by them.
    .replace(/\\+$/, (backslashes) => backslashes + backslashes)

  return `"${escaped}"`
}
