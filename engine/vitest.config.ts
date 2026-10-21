import { defineConfig } from 'vitest/config';

// The engine is tested on its own, from this folder, so its tests never see
// the host project's .autonomy.yml or flow files unless they set them up.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // GITLAB_RETRY_MS: reads are tried again after a 5xx or a dropped
    // connection (#98); no test, nor the CLIs they spawn, waits for that
    env: { AUTONOMY_CONFIG: 'test/fixtures/autonomy.yml', GITLAB_RETRY_MS: '0' },
  },
});
