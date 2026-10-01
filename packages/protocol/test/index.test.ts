import {describe, expect, it} from 'vitest';
import {SUPPORTED_RPC_NODE_TYPES, type RpcNodeType} from '../src/index.js';

describe('protocol', () => {
  it('supports both anvil and kontrol-node trace dialects', () => {
    expect(SUPPORTED_RPC_NODE_TYPES).toEqual(['anvil', 'kontrol-node']);
  });

  it('exposes RpcNodeType members that are all in the supported set', () => {
    const types: RpcNodeType[] = ['anvil', 'kontrol-node'];
    for (const t of types) {
      expect(SUPPORTED_RPC_NODE_TYPES).toContain(t);
    }
  });
});
