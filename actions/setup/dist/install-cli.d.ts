import type { FsClient } from '@finite-state/core';
/**
 * Downloads fs-cli for the current runner from the platform's CLI download
 * endpoint and puts it on PATH. Returns the path to the installed binary.
 *
 * The download URL returned by the API is pre-signed, so the binary itself is
 * fetched without the auth header.
 */
export declare function installFsCli(client: FsClient): Promise<string>;
