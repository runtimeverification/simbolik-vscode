// config.js (your shared preset, flat config - ESM)
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import unicorn from 'eslint-plugin-unicorn';
import eslintComments from '@eslint-community/eslint-plugin-eslint-comments';
import prettierRecommended from 'eslint-plugin-prettier/recommended';
import prettierCompat from 'eslint-config-prettier/flat';

export default tseslint.config(
  js.configs.recommended,
  tseslint.configs.recommended,
  unicorn.configs.recommended,
  {
    plugins: { 'eslint-comments': eslintComments },
    rules: eslintComments.configs.recommended.rules,
  },
  prettierRecommended,
  prettierCompat,

  // ⬇️ TS-only, so JS files (e.g., config.js) won't trigger typed rules
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
    },
  },
);
