import type { SbomFormat } from './models'

/**
 * SBOM formats fs-cli accepts, keyed by every spelling the actions document.
 *
 * Shared by `upload` (`sbom-format`) and `download-sbom` (`format`) so the two
 * cannot drift: a value one action accepts must not be an opaque fs-cli error in
 * the other.
 */
const SBOM_FORMATS: Record<string, SbomFormat> = {
  cdx: 'cyclonedx',
  cyclonedx: 'cyclonedx',
  spdx: 'spdx',
}

/**
 * Normalises an SBOM format input to the token fs-cli's `--format` expects,
 * throwing a named error rather than letting a typo surface as a non-zero
 * fs-cli exit. Case and surrounding whitespace are not the caller's problem.
 */
export function normalizeSbomFormat(
  input: string,
  inputName = 'format',
  hint?: string,
): SbomFormat {
  const format = SBOM_FORMATS[input.trim().toLowerCase()]
  if (!format) {
    throw new Error(
      `${inputName} "${input}" is not recognized. Valid: cdx (cyclonedx) or spdx.` +
        (hint ? ` ${hint}` : ''),
    )
  }
  return format
}
