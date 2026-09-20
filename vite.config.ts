import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import pkg from './package.json';

// SPA build → dist/client (served by the Worker via Static Assets, see wrangler.jsonc)
export default defineConfig({
  root: resolve(__dirname, 'src/web'),
  plugins: [react()],
  // app semver comes from package.json — the single version source of truth
  // (the worker gets it at deploy time via `wrangler deploy --define`)
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  build: {
    outDir: resolve(__dirname, 'dist/client'),
    emptyOutDir: true,
    target: 'es2022',
    // keep the shell lean (NFR-1: < 200 KB gzip target for core JS)
    chunkSizeWarningLimit: 700
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: false,
        ws: true
      }
    }
  }
});
