import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    exclude: ['node_modules/**', '.next/**', 'tests/e2e/**'],
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      reporter: ['text', 'json-summary']
    }
  },
  resolve: {
    alias: {
      'server-only': new URL('./tests/mocks/server-only.ts', import.meta.url).pathname,
      '@': new URL('.', import.meta.url).pathname
    }
  }
});
