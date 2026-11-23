import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Order matters: isolated-config-dir must set APPDATA/HOME/USERPROFILE
    // before isolated-key-store (or any test import) pulls in paths.ts,
    // which computes CONFIG_DIR at import time.
    setupFiles: [
      'src/__fixtures__/isolated-config-dir.ts',
      'src/__fixtures__/isolated-key-store.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/research/**',
        'src/index.ts',
      ],
    },
  },
});
