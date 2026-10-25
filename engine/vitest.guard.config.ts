import { defineConfig } from 'vitest/config';
// The go-ahead guard's in-process tests (the CLI tests spawn node; they are left out under mutation).
export default defineConfig({
  test: {
    include: ['test/goahead.test.ts', 'test/ledger.test.ts', 'test/project-flows.test.ts'],
    // GITLAB_RETRY_MS: reads are tried again after a 5xx or a dropped
    // connection (#98); no test, nor the CLIs they spawn, waits for that
    env: { AUTONOMY_CONFIG: 'test/fixtures/autonomy.yml', GITLAB_RETRY_MS: '0' },
  },
});
