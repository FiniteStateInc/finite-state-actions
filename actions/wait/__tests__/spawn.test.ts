import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as exec from '@actions/exec'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { quoteExecPath } from '../../../packages/core/src/exec-path'

// Everything else in this directory mocks @actions/exec. This file does not: it
// spawns a real process from a directory whose name contains a space, which is
// the case quoteExecPath exists for. Asserting the quoting against
// argStringToArray would only prove the parser agrees with itself — this proves
// the path survives all the way to spawn, on whichever OS the leg is running.

let dir: string
let script: string

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fs cli spawn '))
  script = path.join(dir, process.platform === 'win32' ? 'fake-fs-cli.exe' : 'fake-fs-cli')

  if (process.platform === 'win32') {
    // A .exe, not a batch file, so @actions/exec spawns it directly rather than
    // through the command interpreter — the same route a real fs-cli.exe takes.
    // Node itself is the only executable we can be sure exists, so it stands in
    // for fs-cli and runs a script beside it.
    await fs.copyFile(process.execPath, script)
    await fs.writeFile(
      path.join(dir, 'fake-fs-cli.js'),
      'console.log("ran from " + __dirname)\nprocess.exit(Number(process.argv[2] ?? 0))\n',
    )
  } else {
    await fs.writeFile(script, '#!/bin/sh\necho "ran from $(dirname "$0")"\nexit "${1:-0}"\n')
    await fs.chmod(script, 0o755)
  }
}, 120_000)

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

/** The arguments that make the stand-in behave like the shell script. */
function argsFor(exitCode: string): string[] {
  return process.platform === 'win32' ? [path.join(dir, 'fake-fs-cli.js'), exitCode] : [exitCode]
}

describe('a binary under a path with a space', () => {
  it('runs when the path is quoted, and reports its own exit code', async () => {
    let stdout = ''

    const code = await exec.exec(quoteExecPath(script), argsFor('7'), {
      ignoreReturnCode: true,
      listeners: { stdout: (data: Buffer) => (stdout += data.toString()) },
    })

    expect(code).toBe(7)
    expect(stdout).toContain(dir)
  })

  it('fails when the path is not quoted, which is the bug quoting fixes', async () => {
    // exec parses its first parameter as a command line even with an args
    // array, so the unquoted path splits at the space and the first fragment is
    // spawned instead. Whether that surfaces as a throw or a non-zero code is
    // the platform's business; what matters is that it does not run.
    await expect(
      exec.exec(script, argsFor('0'), { ignoreReturnCode: true, silent: true }),
    ).rejects.toThrow()
  })
})
