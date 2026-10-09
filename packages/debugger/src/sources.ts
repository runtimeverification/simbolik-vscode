/**
 * DAP `Source`s for build-info source files.
 *
 * Trace sources live in the build-info (relative paths; possibly recompiled and
 * not on the client's disk). On a local launch a file that exists under the
 * project root is referenced by its real absolute path, so VSCode opens the
 * editable document and gutter breakpoints work. Otherwise its content is served
 * through the `source` request under a stable `sourceReference`, keeping the
 * relative `path` as the identity breakpoints and the stepping model share.
 */
import {existsSync} from 'node:fs';
import * as nodePath from 'node:path';

import type {DebugProtocol} from '@vscode/debugprotocol';

import type {CompilationUnit, SourceFile} from '@simbolik/solc';

/** The last path segment (the file name) of a `/`-separated path. */
function baseName(path: string): string {
  return path.split('/').pop() ?? path;
}

export class SourceRegistry {
  readonly #root: string | undefined;
  readonly #refs = new Map<SourceFile, number>();
  readonly #byRef = new Map<number, SourceFile>();
  #seq = 1;

  /** `root`: the absolute directory relative build-info paths resolve against. */
  constructor(root: string | undefined) {
    this.#root = root === '' ? undefined : root;
  }

  /**
   * The DAP `Source` for `(cu, sourcePath)`, or `undefined` when the CU has no
   * such source file.
   */
  sourceFor(
    cu: CompilationUnit,
    sourcePath: string
  ): DebugProtocol.Source | undefined {
    const file = cu.sourceByPath(sourcePath);
    if (file === undefined) return undefined;
    const name = baseName(sourcePath);
    if (this.#root !== undefined) {
      const abs = nodePath.resolve(this.#root, sourcePath);
      if (existsSync(abs)) return {name, path: abs};
    }
    let ref = this.#refs.get(file);
    if (ref === undefined) {
      ref = this.#seq++;
      this.#refs.set(file, ref);
      this.#byRef.set(ref, file);
    }
    return {name, path: sourcePath, sourceReference: ref};
  }

  /**
   * {@link sourceFor}, degrading to a best-effort path-only `Source` when the CU
   * has no matching file (an unmapped step).
   */
  sourceOrPath(cu: CompilationUnit, sourcePath: string): DebugProtocol.Source {
    return (
      this.sourceFor(cu, sourcePath) ?? {
        name: baseName(sourcePath),
        path: sourcePath,
      }
    );
  }

  /** The content served for a `sourceReference` handed out by {@link sourceFor}. */
  content(sourceReference: number): {content: string; mimeType?: string} {
    const file = this.#byRef.get(sourceReference);
    if (file === undefined) {
      throw new Error(`unknown sourceReference: ${sourceReference}`);
    }
    return {content: file.content, mimeType: 'text/x-solidity'};
  }

  /**
   * Map an incoming breakpoint source path back to the relative build-info path
   * the stepping model keys breakpoints by: when frames reference the real
   * on-disk file, VSCode sends an absolute path.
   */
  relativePath(path: string): string {
    if (this.#root !== undefined && nodePath.isAbsolute(path)) {
      const rel = nodePath
        .relative(this.#root, path)
        .split(nodePath.sep)
        .join('/');
      // Only accept a path that stays within the root (no leading '..').
      if (!rel.startsWith('..')) return rel;
    }
    return path;
  }
}
