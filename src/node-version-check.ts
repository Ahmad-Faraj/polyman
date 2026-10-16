/**
 * @fileoverview Fails fast with a readable message on an unsupported Node.js version.
 * Must be the first import of cli.ts and must not import anything else: the
 * compiled CommonJS output loads chalk (ESM-only) with `require`, which throws
 * ERR_REQUIRE_ESM on Node < 20.19 and on 22.0 to 22.11 before any other code runs.
 */

const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);

const supported =
  (major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major > 22;

if (!supported) {
  console.error(
    `polyman requires Node.js ^20.19.0 || >=22.12.0 (found ${process.versions.node}).\n` +
      'Please upgrade Node.js: https://nodejs.org/'
  );
  process.exit(1);
}
