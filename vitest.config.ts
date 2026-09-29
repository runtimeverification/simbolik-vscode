import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    // Co-located specs across every workspace package.
    include: [
      'packages/*/src/**/*.test.ts',
      'packages/*/test/**/*.test.ts',
      'src/**/*.test.ts',
    ],
    // The extension (root src/) is mostly VSCode-host-coupled and not part of
    // the Vitest core suite; its few vscode-free modules (e.g. nodeSetup.ts)
    // keep a co-located spec.
    watch: false,
  },
});
