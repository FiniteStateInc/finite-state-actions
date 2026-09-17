import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@actions/core', () => ({
  warning: vi.fn(),
}))

import * as core from '@actions/core'
import { parseTimeoutMinutes } from '../src/timeout'

describe('parseTimeoutMinutes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns undefined for an empty or whitespace input, leaving fs-cli its own default', () => {
    expect(parseTimeoutMinutes(undefined)).toBeUndefined()
    expect(parseTimeoutMinutes('')).toBeUndefined()
    expect(parseTimeoutMinutes('   ')).toBeUndefined()
  })

  it.each([
    ['600', 10],
    ['60', 1],
    ['3600', 60],
  ])('converts %s whole seconds to %i minute(s) without warning', (input, minutes) => {
    expect(parseTimeoutMinutes(input)).toBe(minutes)
    expect(core.warning).not.toHaveBeenCalled()
  })

  it.each([
    ['90', 2],
    ['30', 1],
    ['1', 1],
    ['61', 2],
  ])('rounds %s seconds up to %i minute(s) and says so', (input, minutes) => {
    expect(parseTimeoutMinutes(input)).toBe(minutes)
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining(`rounding up to ${minutes} minute(s)`),
    )
  })

  it.each([
    ['0600', 10],
    ['09', 1],
  ])('reads the leading-zero input %s as base 10 (%i minutes)', (input, minutes) => {
    // The bash implementation this replaced read "0600" as octal 384 and
    // aborted outright on "09".
    expect(parseTimeoutMinutes(input)).toBe(minutes)
  })

  it.each(['600s', '10 minutes', 'abc', '1.5', '-5', '1e3', '+60'])(
    'rejects the malformed input %j',
    (input) => {
      expect(() => parseTimeoutMinutes(input)).toThrow(/timeout must be a whole number of seconds/)
    },
  )

  it.each(['0', '00'])('rejects the non-positive input %j', (input) => {
    expect(() => parseTimeoutMinutes(input)).toThrow(/positive number of seconds/)
  })
})
