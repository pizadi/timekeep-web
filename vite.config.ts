import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
// `import.meta.dirname` + an import attribute, not `__dirname` and a bare JSON
// import: Vite 8 loads this config with the native loader by default in the next
// major, where both of the old forms stop working.
import pkg from './package.json' with { type: 'json' };

const root = import.meta.dirname;

// SPA build → dist/client (served by the Worker via Static Assets, see wrangler.jsonc)
export default defineConfig({
  root: resolve(root, 'src/web'),
  plugins: [react()],
  // app semver comes from package.json — the single version source of truth
  // (the worker gets it at deploy time via `wrangler deploy --define`)
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  build: {
    outDir: resolve(root, 'dist/client'),
    emptyOutDir: true,
    target: 'es2022',
    // keep the shell lean (NFR-1: < 200 KB gzip target for core JS)
    chunkSizeWarningLimit: 700,
  },
  server: {
    // Explicitly IPv4 loopback. Vite 8 binds only [::1] by default, which makes
    // http://127.0.0.1:5173 fail with a connection refused while localhost still
    // works — the API proxy below already targets 127.0.0.1, so pinning IPv4
    // keeps both spellings of the dev URL working and matches the worker.
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: false,
        ws: true,
      },
    },
  },
});
