// eslint.config.js
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import { fileURLToPath } from 'node:url';
import eslintComments from '@eslint-community/eslint-plugin-eslint-comments';
import rv from 'eslint-config-rv-web-nestjs';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig([
  {
    ignores: [
      '**/.eslintrc.js',
      'src/@generated/**',
      'build/**',
      'build-web/**',
    ],
  },
  { plugins: { '@eslint-community/eslint-comments': eslintComments } },

  // ⬇️ flatten the shared config (no nested `extends`)
  ...rv,
  {
    rules: {
      'unicorn/prevent-abbreviations': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      'unicorn/filename-case': [
        'error',
        {
          cases: {
            kebabCase: false,
            pascalCase: false,
            camelCase: true,
          },
        },
      ],
    },
  },
  {
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: 'tsconfig.json',
        tsconfigRootDir: __dirname,
        sourceType: 'module',
      },
      globals: { ...globals.node, ...globals.jest },
    },
    plugins: { '@typescript-eslint': tsPlugin },
  },
  {
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: 'tsconfig.web.json',
        tsconfigRootDir: __dirname,
        sourceType: 'module',
      },
      globals: { ...globals.browser, ...globals.jest },
    },
    plugins: { '@typescript-eslint': tsPlugin },
  },
]);
