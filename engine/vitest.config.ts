import { defineConfig } from 'vitest/config';

// The engine is tested on its own, from this folder, so its tests never see
// the host project's .autonomy.yml or flow files unless they set them up.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    env: { AUTONOMY_CONFIG: 'test/fixtures/autonomy.yml' },
  },
});
