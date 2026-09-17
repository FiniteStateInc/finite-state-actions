import { describe, it, expect } from 'vitest'
import { quoteExecPath } from '../src/exec-path'

describe('quoteExecPath', () => {
  it('quotes a Windows path with spaces so exec does not split it', () => {
    expect(quoteExecPath('C:\\Program Files\\fs-cli\\fs-cli.exe')).toBe(
      '"C:\\Program Files\\fs-cli\\fs-cli.exe"',
    )
  })

  it('quotes a plain path too, so no call site has to decide', () => {
    expect(quoteExecPath('/usr/local/bin/fs-cli')).toBe('"/usr/local/bin/fs-cli"')
  })

  it('escapes an embedded quote, which would otherwise end the quoted run early', () => {
    expect(quoteExecPath('/tmp/we"ird/fs-cli')).toBe('"/tmp/we\\"ird/fs-cli"')
  })
})
