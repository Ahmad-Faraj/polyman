import { defineConfig } from 'vitest/config';
// The go-ahead guard's in-process tests (the CLI tests spawn node; they are left out under mutation).
export default defineConfig({
  test: {
    include: ['test/goahead.test.ts', 'test/ledger.test.ts', 'test/project-flows.test.ts'],
    env: { AUTONOMY_CONFIG: 'test/fixtures/autonomy.yml' },
  },
});
