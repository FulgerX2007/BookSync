import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'dist-e2e/', 'coverage/', 'test-results/', 'playwright-report/', 'web-ext-artifacts/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        globalThis: 'readonly',
        URL: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    files: ['build.mjs', 'scripts/**/*.mjs', 'e2e/**/*.ts', 'playwright.config.ts'],
    rules: { 'no-console': 'off' },
  },
);
