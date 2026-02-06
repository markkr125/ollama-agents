import vue from '@vitejs/plugin-vue';
import { resolve } from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: resolve(__dirname),
  plugins: [vue()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: [resolve(__dirname, 'tests/setup.ts')],
    include: [resolve(__dirname, 'tests/**/*.test.ts')],
    clearMocks: true
  }
});
