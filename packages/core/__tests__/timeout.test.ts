import { describe, it, expect } from 'vitest'
import { timeoutSecondsToMinutes } from '../src/timeout'

describe('timeoutSecondsToMinutes', () => {
  it('returns no minutes for an empty or whitespace input, leaving fs-cli its own default', () => {
    expect(timeoutSecondsToMinutes(undefined)).toEqual({})
    expect(timeoutSecondsToMinutes('')).toEqual({})
    expect(timeoutSecondsToMinutes('   ')).toEqual({})
  })

  it.each([
    ['600', 10],
    ['60', 1],
    ['3600', 60],
  ])('converts %s whole seconds to %i minute(s) with nothing to warn about', (input, minutes) => {
    expect(timeoutSecondsToMinutes(input)).toEqual({ minutes })
  })

  it.each([
    ['90', 2],
    ['30', 1],
    ['1', 1],
    ['61', 2],
  ])('rounds %s seconds up to %i minute(s) and returns the message', (input, minutes) => {
    const { minutes: got, warning } = timeoutSecondsToMinutes(input)

    expect(got).toBe(minutes)
    expect(warning).toContain(`rounding up to ${minutes} minute(s)`)
  })

  it('returns the rounding message rather than writing it, so the caller titles it', () => {
    // The action, not core, owns the annotation: core has no Actions logging
    // channel of its own to write to.
    expect(timeoutSecondsToMinutes('90').warning).toMatch(/^timeout 90s is not a whole number/)
  })

  it.each([
    ['0600', 10],
    ['09', 1],
  ])('reads the leading-zero input %s as base 10 (%i minutes)', (input, minutes) => {
    // The bash implementation this replaced read "0600" as octal 384 and
    // aborted outright on "09".
    expect(timeoutSecondsToMinutes(input).minutes).toBe(minutes)
  })

  it.each(['600s', '10 minutes', 'abc', '1.5', '-5', '1e3', '+60'])(
    'rejects the malformed input %j as not a whole number',
    (input) => {
      expect(() => timeoutSecondsToMinutes(input)).toThrow(
        /timeout must be a whole number of seconds/,
      )
    },
  )

  it.each(['0', '00'])('rejects the input %j as not positive', (input) => {
    // A distinct message from the one above: "0" parses fine and is rejected
    // for its value, which is the difference a caller has to act on.
    expect(() => timeoutSecondsToMinutes(input)).toThrow(
      /timeout must be a positive number of seconds/,
    )
  })
})
