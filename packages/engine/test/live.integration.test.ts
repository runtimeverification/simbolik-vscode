import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {KontrolNode, devcontainerLaunch} from '../src/index.js';

/**
 * Live integration test against a REAL kontrol-node.
 *
 * Skipped unless SIMBOLIK_LIVE=1, because it needs the dev-container-provisioned
 * engine (nix dev shell + built KEVM semantics). The core Vitest suite runs on
 * recorded fixtures and never requires the K runtime. Run locally with:
 *   SIMBOLIK_LIVE=1 npx vitest run packages/engine/test/live.integration.test.ts
 */
const live = process.env.SIMBOLIK_LIVE === '1';

function loadDeployParams(): Record<string, string> {
  const doc = JSON.parse(
    readFileSync(
      new URL(
        './fixtures/eth_sendTransaction_deploy_counter.in.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as {params: Array<Record<string, string>>};
  return doc.params[0];
}

describe.skipIf(!live)('kontrol-node live', () => {
  it(
    'spawns, deploys Counter, and returns a lossless trace',
    async () => {
      const deployParams = loadDeployParams();
      const port = 8720 + Math.floor((Date.now() % 200));
      const node = new KontrolNode({
        port,
        launch: devcontainerLaunch(port),
        readyTimeoutMs: 240_000,
        readyPollMs: 1000,
      });
      try {
        await node.start();

        const chainId = await node.client.call('eth_chainId');
        expect(Number(chainId)).toBe(31337);

        const txHash = await node.client.call<string>('eth_sendTransaction', [
          deployParams,
        ]);
        expect(txHash).toMatch(/^0x[0-9a-f]{64}$/);

        const trace = await node.client.call<{
          structLogs: Array<{codeAddress: bigint; pc: number}>;
        }>('debug_traceTransaction', [txHash, {}]);

        expect(trace.structLogs.length).toBeGreaterThan(0);
        // The precision-critical field: a 160-bit address as exact bigint.
        expect(typeof trace.structLogs[0].codeAddress).toBe('bigint');
      } finally {
        await node.stop();
      }
    },
    300_000,
  );
});
