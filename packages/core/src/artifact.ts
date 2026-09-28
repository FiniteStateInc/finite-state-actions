import * as core from '@actions/core'

/**
 * Runs an artifact upload, downgrading GitHub Enterprise Server's refusal to a
 * warning.
 *
 * `@actions/artifact` v2 throws `GHESNotSupportedError` before it sends
 * anything when the runner is talking to GHES, and no version of it works
 * there — v2 is the only line still maintained, and `upload-artifact@v4`
 * carries the same limit. So on GHES this is not a transient failure to retry
 * or a misconfiguration to fix: the upload cannot happen at all. Failing the
 * step for it means a GHES job can never go green even though the work it
 * asked for — the SBOM, the report — completed and the files are sitting on
 * the runner, reachable through each action's path output.
 *
 * Every other upload error still throws. A network failure, a name collision
 * or a missing file is worth a red run, and swallowing those would turn a real
 * "your artifact is not there" into silence.
 *
 * The upload arrives as a thunk rather than this module constructing the
 * client itself, so core keeps no dependency on `@actions/artifact`. Only two
 * of the eight actions upload anything, and core is re-exported wholesale into
 * every bundle: importing the package here would add ~3.6 MB to the six that
 * never call it.
 *
 * Returns whether the upload happened, for callers that report it.
 */
export async function uploadArtifactUnlessGhes(
  name: string,
  upload: () => Promise<unknown>,
): Promise<boolean> {
  try {
    await upload()
    return true
  } catch (err) {
    // Matched on `name`, not `instanceof`: the class is not exported from the
    // package's entry point, and the action and core could otherwise resolve
    // two copies of it.
    if (err instanceof Error && err.name === 'GHESNotSupportedError') {
      core.warning(
        `Artifact "${name}" was not uploaded: ${err.message} The files are still on the ` +
          'runner — upload them with actions/upload-artifact@v3, which GHES does support, or ' +
          'turn the upload off in this step to drop the warning.',
        { title: 'Artifact upload unsupported on GHES' },
      )
      return false
    }
    throw err
  }
}
