import { describe, it, expect } from 'vitest'
import { fetchFailure } from '../src/fetch-error'

describe('fetchFailure', () => {
  it('names the request and every reason under a bare fetch failure', () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 10.116.253.49:80'), {
      code: 'ECONNREFUSED',
    })
    const err = fetchFailure(
      'https://app.finitestate.io/api/public/v0/sboms',
      new TypeError('fetch failed', { cause }),
    )

    expect(err.message).toBe(
      'Request to https://app.finitestate.io/api/public/v0/sboms failed: fetch failed: ' +
        'connect ECONNREFUSED 10.116.253.49:80 (ECONNREFUSED)',
    )
  })

  it('unpacks an AggregateError from a multi-address connect', () => {
    const inner = new AggregateError(
      [
        Object.assign(new Error('connect ETIMEDOUT 1.2.3.4:443'), { code: 'ETIMEDOUT' }),
        Object.assign(new Error('connect ECONNRESET 1.2.3.5:443'), { code: 'ECONNRESET' }),
      ],
      'all attempts failed',
    )
    const err = fetchFailure(
      'the fs-cli download URL',
      new TypeError('fetch failed', { cause: inner }),
    )

    expect(err.message).toContain('ETIMEDOUT')
    expect(err.message).toContain('ECONNRESET')
  })

  it('keeps the original error as cause', () => {
    const original = new TypeError('fetch failed')
    expect(fetchFailure('x', original).cause).toBe(original)
  })
})
