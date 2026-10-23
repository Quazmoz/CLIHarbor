import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    cors: false,
    hmr: false,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    restoreMocks: true,
    // One jsdom per worker VM instead of one per file: same per-file module
    // isolation, but environment setup dropped from ~75% of wall time and the
    // suite from ~110-250s to ~21s on a 2-core runner.
    pool: 'vmThreads',
  },
});
