/**
 * The dynamic-import SEAM between the CJS VSCode extension and the
 * separately-bundled ESM debug server (`build/server.mjs`, source `src/server.ts`).
 *
 * WHY A SEAM: the extension is bundled `--format=cjs` (see `esbuild-base`), but
 * the debug server transitively pulls in `@ethdebug/pointers`, which uses
 * TOP-LEVEL AWAIT — illegal in a CJS bundle. So the server is bundled on its own
 * as ESM (`build/server.mjs`) and loaded here at RUNTIME via a dynamic
 * `import()` (CJS → local ESM, supported by Node 22 in the extension host).
 *
 * TSC vs RUNTIME path: at runtime the file is `build/server.mjs`, an ESM bundle
 * whose graph uses TOP-LEVEL AWAIT — so it can ONLY be reached through a genuine
 * ESM `import()`; a `require()` throws "cannot be used on an ESM graph with
 * top-level await". The catch: the extension is emitted as CommonJS by BOTH
 * toolchains that build it —
 *   - `tsc -p ./tsconfig.json` (the default build task) down-levels EVERY dynamic
 *     `import()` to `require()` under `module: commonjs`, even a computed one, and
 *   - `esbuild --format=cjs` would statically follow + INLINE a literal specifier
 *     into `extension.js`.
 * A computed string specifier defeats only esbuild. To survive tsc as well we
 * build the importer with the `Function` constructor: its body is an opaque
 * string to both tools, so neither rewrites the `import()` inside it — at runtime
 * it is a real ESM dynamic import. We hand it an ABSOLUTE `file://` URL derived
 * from `__dirname` (defined in both CJS outputs), so the specifier never resolves
 * against the wrong base regardless of how the extension was bundled.
 *
 * The module's SHAPE is typed statically via `@simbolik/debugger`'s public types
 * (type-only imports, erased at compile time), so callers still get full types
 * without a static link to `server.ts`.
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
 * A genuine ESM dynamic `import()`, built via the `Function` constructor so that
 * neither `tsc` (which would emit `require()`) nor `esbuild` (which would inline)
 * can rewrite it. See the file header. Typed as a plain function returning the
 * imported namespace.
 */
const esmImport = new Function('url', 'return import(url);') as (
  url: string
) => Promise<unknown>;

/**
 * Dynamically load the ESM debug-server bundle from the CJS extension host.
 * This is the inline-mode seam; the tcp-mode path spawns `server.mjs` instead.
 *
 * `server.mjs` sits beside the built extension entry, so we resolve it against
 * `__dirname` (present in both the tsc and esbuild CJS outputs) and import it as
 * an absolute `file://` URL — unambiguous regardless of the current working dir.
 */
export async function loadServer(): Promise<ServerModule> {
  const serverPath = nodePath.join(__dirname, 'server.mjs');
  const mod = await esmImport(pathToFileURL(serverPath).href);
  return mod as ServerModule;
}
