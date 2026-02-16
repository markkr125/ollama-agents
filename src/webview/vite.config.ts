import vue from '@vitejs/plugin-vue';
import { resolve } from 'path';
import { defineConfig } from 'vite';

export default defineConfig({
  root: resolve(__dirname),
  plugins: [vue()],
  base: './',
  build: {
    outDir: resolve(__dirname, '../../media'),
    emptyOutDir: false,
    rollupOptions: {
      input: {
        chatView: resolve(__dirname, 'index.html')
      },
      output: {
        entryFileNames: 'chatView.js',
        chunkFileNames: 'chatView.js',
        assetFileNames: assetInfo => {
          if (assetInfo.name === 'style.css') {
            return 'chatView.css';
          }
          if (assetInfo.name?.endsWith('.ttf')) {
            return 'codicon.ttf';
          }
          return 'chatView.[ext]';
        }
      }
    }
  }
});
