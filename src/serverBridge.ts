/**
 * Loads the separately bundled ESM debug server (`build/server.mjs`, source
 * `src/server.ts`) from the CommonJS extension host.
 *
 * The server depends on `@ethdebug/pointers`, which uses top-level await, so it
 * cannot be bundled into the CJS extension and cannot be loaded with
 * `require()`. It has to be reached through a real ESM `import()`. Both
 * toolchains that emit the extension get in the way of that:
 *   - `tsc` under `module: commonjs` rewrites every dynamic `import()` to
 *     `require()`, even with a computed specifier;
 *   - `esbuild --format=cjs` inlines an `import()` with a literal specifier.
 * Building the importer with the `Function` constructor hides the `import()`
 * from both. The specifier is an absolute `file://` URL derived from
 * `__dirname`, so it resolves the same way in either build.
 *
 * The module shape is typed via `@simbolik/debugger`'s public types (type-only
 * imports), so callers are fully typed without a static link to `server.ts`.
 */
import {pathToFileURL} from 'node:url';
import * as nodePath from 'node:path';

import type {
  DapDispatcher,
  SessionResolver,
  DapServerHandle,
} from '@simbolik/debugger';

/** The public surface of `src/server.ts` (built to `build/server.mjs`). */
export interface ServerModule {
  createDispatcher(resolve?: SessionResolver): DapDispatcher;
  startServer(opts: {
    port: number;
    host?: string;
    resolve?: SessionResolver;
  }): Promise<DapServerHandle>;
  notWiredResolver: SessionResolver;
}

/**
 * A real ESM dynamic `import()` that neither `tsc` nor `esbuild` can rewrite
 * (see the file header).
 */
const esmImport = new Function('url', 'return import(url);') as (
  url: string
) => Promise<unknown>;

/**
 * Load the debug-server bundle in-process (inline mode; tcp mode spawns
 * `server.mjs` instead). `server.mjs` sits beside the built extension entry.
 */
export async function loadServer(): Promise<ServerModule> {
  const serverPath = nodePath.join(__dirname, 'server.mjs');
  const mod = await esmImport(pathToFileURL(serverPath).href);
  return mod as ServerModule;
}
