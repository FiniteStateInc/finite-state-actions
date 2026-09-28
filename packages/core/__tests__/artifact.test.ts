import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@actions/core', () => ({
  warning: vi.fn(),
}))

import * as core from '@actions/core'
import { uploadArtifactUnlessGhes } from '../src/artifact'

/** The error @actions/artifact throws on GHES, reproduced by name. */
function ghesError(): Error {
  const err = new Error(
    '@actions/artifact v2.0.0+, upload-artifact@v4+ and download-artifact@v4+ are not currently supported on GHES.',
  )
  err.name = 'GHESNotSupportedError'
  return err
}

describe('uploadArtifactUnlessGhes', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reports a successful upload and warns about nothing', async () => {
    await expect(uploadArtifactUnlessGhes('sbom', async () => undefined)).resolves.toBe(true)
    expect(core.warning).not.toHaveBeenCalled()
  })

  it('warns and reports no upload when the runner is GHES', async () => {
    await expect(
      uploadArtifactUnlessGhes('sbom', async () => {
        throw ghesError()
      }),
    ).resolves.toBe(false)

    const [message, options] = vi.mocked(core.warning).mock.calls[0]
    expect(message).toContain('sbom')
    expect(message).toContain('not currently supported on GHES')
    // The workaround, not just the diagnosis: a GHES job needs to know the
    // files survived and how to get them.
    expect(message).toContain('actions/upload-artifact@v3')
    expect(options).toEqual({ title: 'Artifact upload unsupported on GHES' })
  })

  it('rethrows any other upload failure', async () => {
    await expect(
      uploadArtifactUnlessGhes('sbom', async () => {
        throw new Error('ECONNRESET')
      }),
    ).rejects.toThrow('ECONNRESET')
    expect(core.warning).not.toHaveBeenCalled()
  })
})
