import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    // Specs across every workspace package. In the extension (root src/), only
    // modules that don't import `vscode` (e.g. nodeSetup.ts) can have specs.
    include: [
      'packages/*/src/**/*.test.ts',
      'packages/*/test/**/*.test.ts',
      'src/**/*.test.ts',
    ],
    watch: false,
  },
});
