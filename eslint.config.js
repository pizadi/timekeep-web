// ESLint flat config (audit #8 — the repo had no linter; consistency relied on
// review discipline alone).
//
// Rule posture, chosen to land green without a big-bang cleanup while still
// catching the classes of bug that matter here:
//   - typescript-eslint recommended (type-aware off — tsc already does that job
//     in CI, and noUnusedLocals/noUnusedParameters are on in both tsconfigs)
//   - react-hooks rules-of-hooks = error, exhaustive-deps = warn (several
//     effects legitimately read fresh state; a warning is the honest signal and
//     keeps `npm run lint` blocking on errors only)
//   - no-explicit-any OFF: the store/api layer is deliberately `any`-typed at
//     its edges (bootstrap payloads, WS events) and rewriting that is its own
//     project
//   - eslint-config-prettier last, so it switches off anything that would fight
//     Prettier (dev13)
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      '.wrangler/**',
      '.work/**',
      '.plan/**',
      '**/*.md',
      'wrangler.local.jsonc',
      'wrangler.ci.jsonc',
      'src/worker/10k-most-common.txt',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Applies to every TS file in the repo: the store/api layer is deliberately
  // `any`-typed at its edges (bootstrap payloads, WS event data, D1 rows) and
  // rewriting that is its own project — see the note in the header.
  // `^_` is the codebase's convention for "intentionally unused" (the Worker
  // entry's `_ctx`, the DO's `_ws`/`_code`, WebSocket handlers).
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },

  // plain browser scripts shipped as-is (service worker, theme boot) — they
  // run in the browser but aren't part of the TS build
  {
    files: ['src/web/public/**/*.js'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.serviceworker },
      sourceType: 'script',
    },
    rules: { 'no-undef': 'off', '@typescript-eslint/no-unused-vars': 'off' },
  },

  // SPA: browser globals, JSX, hooks
  {
    files: ['src/web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // a Worker/edge runtime is not the DOM
      'no-undef': 'off',
    },
  },

  // Worker + shared: no DOM, Cloudflare types come from @cloudflare/workers-types
  {
    files: ['src/worker/**/*.ts', 'src/shared/**/*.ts', 'test/**/*.ts', '*.config.ts', 'worker-env.d.ts'],
    languageOptions: { globals: { ...globals.node } },
    rules: { 'no-undef': 'off' },
  },

  // node scripts (e2e, scripts/) — plain ESM, node globals
  {
    files: ['e2e/**/*.mjs', 'scripts/**/*.mjs', 'vitest.config.ts', 'vite.config.ts'],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    },
  },

  // e2e scripts exit non-zero and print with console.log — that's the contract
  {
    files: ['e2e/**/*.mjs', 'scripts/**/*.mjs'],
    rules: { 'no-console': 'off' },
  },

  prettier,
);
