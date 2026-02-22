// @ts-check
import eslint from '@eslint/js';
import pluginVue from 'eslint-plugin-vue';
import tseslint from 'typescript-eslint';
import vueParser from 'vue-eslint-parser';

export default tseslint.config(
  // ── Global ignores ───────────────────────────────────────────────
  {
    ignores: [
      'out/**',
      'dist/**',
      'media/**',
      'node_modules/**',
      '.vscode-test/**',
      'scripts/**',
      'agents-refrences/**',
      '**/*.d.ts',
      'webpack.config.js',
    ],
  },

  // ── Base: all TypeScript files ───────────────────────────────────
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    rules: {
      // Relax rules that are too noisy for this codebase
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',

      // Useful catches
      'no-constant-condition': ['error', { checkLoops: false }], // allow while(true)
      'no-fallthrough': 'error',
      'eqeqeq': ['error', 'always', { null: 'ignore' }],
      'no-throw-literal': 'error',
      'prefer-const': 'warn',

      // Allow empty catch blocks with a comment
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-empty-function': 'off',
    },
  },

  // ── Extension code (Node/CommonJS) ───────────────────────────────
  {
    files: ['src/**/*.ts'],
    ignores: ['src/webview/**'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        URL: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
      },
    },
  },

  // ── Webview TypeScript files ─────────────────────────────────────
  {
    files: ['src/webview/**/*.ts'],
    languageOptions: {
      globals: {
        console: 'readonly',
        window: 'readonly',
        document: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        requestAnimationFrame: 'readonly',
        MutationObserver: 'readonly',
        HTMLElement: 'readonly',
        Element: 'readonly',
        Event: 'readonly',
        MessageEvent: 'readonly',
        KeyboardEvent: 'readonly',
        ClipboardEvent: 'readonly',
      },
    },
    rules: {
      // Enforce: no importing vscode in webview (Pitfall #1)
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['vscode'],
          message: 'Cannot import "vscode" in webview code — it runs in a sandboxed iframe. Use acquireVsCodeApi() via state.ts instead.',
        }],
      }],
    },
  },

  // ── Vue single-file components ───────────────────────────────────
  ...pluginVue.configs['flat/recommended'],
  {
    files: ['src/webview/**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tseslint.parser,
        sourceType: 'module',
      },
      globals: {
        console: 'readonly',
        window: 'readonly',
        document: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        requestAnimationFrame: 'readonly',
        MutationObserver: 'readonly',
        HTMLElement: 'readonly',
        HTMLDivElement: 'readonly',
        HTMLTextAreaElement: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLSelectElement: 'readonly',
        Element: 'readonly',
        Event: 'readonly',
        MessageEvent: 'readonly',
        KeyboardEvent: 'readonly',
        ClipboardEvent: 'readonly',
        getComputedStyle: 'readonly',
      },
    },
    rules: {
      // Enforce: no importing vscode in webview (Pitfall #1)
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['vscode'],
          message: 'Cannot import "vscode" in webview code — it runs in a sandboxed iframe. Use acquireVsCodeApi() via state.ts instead.',
        }],
      }],

      // Vue rules tuned for this project
      'vue/multi-word-component-names': 'off', // We have single-word names like App.vue
      'vue/no-v-html': 'off', // We use v-html for rendered markdown
      'vue/no-mutating-props': 'off', // Settings components deliberately mutate reactive prop objects
      'vue/require-default-prop': 'off', // Not needed with TS defaults
      'vue/attribute-hyphenation': 'off', // We use camelCase props throughout
      'vue/max-attributes-per-line': 'off', // Let formatting be flexible
      'vue/singleline-html-element-content-newline': 'off',
      'vue/html-self-closing': ['warn', {
        html: { void: 'always', normal: 'never', component: 'always' },
      }],
    },
  },

  // ── Test files ───────────────────────────────────────────────────
  {
    files: ['tests/**/*.ts'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        describe: 'readonly',
        it: 'readonly',
        before: 'readonly',
        beforeEach: 'readonly',
        after: 'readonly',
        afterEach: 'readonly',
        suite: 'readonly',
        test: 'readonly',
      },
    },
    rules: {
      // Relax for test files
      '@typescript-eslint/no-unused-expressions': 'off',
      'no-empty': 'off',
    },
  },
);
