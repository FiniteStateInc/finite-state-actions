import { describe, it, expect } from 'vitest'
import { normalizeSbomFormat } from '../src/sbom-format'

describe('normalizeSbomFormat', () => {
  it('maps every documented spelling to the token fs-cli expects', () => {
    expect(normalizeSbomFormat('cyclonedx')).toBe('cyclonedx')
    expect(normalizeSbomFormat('cdx')).toBe('cyclonedx')
    expect(normalizeSbomFormat('spdx')).toBe('spdx')
  })

  it('ignores case and surrounding whitespace', () => {
    expect(normalizeSbomFormat('  CycloneDX ')).toBe('cyclonedx')
    expect(normalizeSbomFormat('CDX')).toBe('cyclonedx')
    expect(normalizeSbomFormat('SPDX\n')).toBe('spdx')
  })

  it('names the input it was given, so each action reports its own', () => {
    expect(() => normalizeSbomFormat('swid', 'sbom-format')).toThrow(/sbom-format "swid"/)
    expect(() => normalizeSbomFormat('swid')).toThrow(/format "swid"/)
  })

  it('rejects an unrecognized value rather than passing it through', () => {
    expect(() => normalizeSbomFormat('spdx-json')).toThrow(/is not recognized/)
    expect(() => normalizeSbomFormat('')).toThrow(/is not recognized/)
  })

  it('appends a caller-supplied hint when there is one', () => {
    expect(() => normalizeSbomFormat('swid', 'sbom-format', 'Leave it unset.')).toThrow(
      /Leave it unset\./,
    )
    expect(() => normalizeSbomFormat('swid')).toThrow(/spdx\.$/)
  })
})
