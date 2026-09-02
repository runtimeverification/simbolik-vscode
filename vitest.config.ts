import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    // Co-located specs across every workspace package.
    include: ['packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    // The extension (root src/) is VSCode-host-coupled and not part of the
    // Vitest core suite; only the new server packages are unit-tested here.
    watch: false,
  },
});
