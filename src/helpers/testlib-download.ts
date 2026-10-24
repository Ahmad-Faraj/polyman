/**
 * @fileoverview Utility for downloading testlib.h from GitHub.
 * Provides simple file download functionality with redirect handling.
 */

import https from 'https';
import { PolymanError } from '../errors';

/**
 * Downloads a file from a URL using HTTPS.
 * Automatically handles HTTP redirects (301, 302).
 *
 * @param {string} url - The URL to download from
 * @returns {Promise<string>} The downloaded file content as a string
 *
 * @throws {PolymanError} With exit code 4 if the download fails or the HTTP
 *   status is not 200/301/302
 *
 * @example
 * const testlibContent = await downloadFile(
 *   'https://raw.githubusercontent.com/MikeMirzayanov/testlib/master/testlib.h'
 * );
 * fs.writeFileSync('testlib.h', testlibContent);
 */
export function downloadFile(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https
      .get(url, response => {
        if (response.statusCode === 302 || response.statusCode === 301) {
          const redirectUrl = response.headers.location;
          if (redirectUrl) {
            downloadFile(redirectUrl).then(resolve).catch(reject);
            return;
          }
        }

        if (response.statusCode !== 200) {
          reject(
            new PolymanError(
              `Failed to download file. HTTP status: ${response.statusCode}`,
              4
            )
          );
          return;
        }

        let data = '';
        response.on('data', (chunk: Buffer) => {
          data += chunk.toString();
        });

        response.on('end', () => {
          resolve(data);
        });
      })
      .on('error', err => {
        reject(new PolymanError(`Download failed: ${err.message}`, 4));
      });
  });
}
