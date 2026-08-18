import { defineConfig } from 'vitest/config';

export default defineConfig({
  optimizeDeps: {
    noDiscovery: true,
    include: [],
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
