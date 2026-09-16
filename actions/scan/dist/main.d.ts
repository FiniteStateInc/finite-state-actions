/**
 * Pulls the platform's project and version IDs out of fs-cli's log output.
 *
 * fs-cli reports them three times over a successful scan, so both a completed
 * and an interrupted run have something to read:
 *
 *   msg="using project" name=WebGoat id=9b590756-...
 *   msg="using version" version=v1.2.3 id=a097b616-...
 *   msg="scan complete" ... submissionID=platform:9b590756-...:a097b616-...
 *
 * The submission ID carries both, so it is tried first.
 */
export declare function parseScanIds(output: string): {
    projectId?: string;
    versionId?: string;
};
export declare function run(): Promise<void>;
