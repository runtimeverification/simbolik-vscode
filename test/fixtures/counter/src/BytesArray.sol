// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

/// @notice viaIR reproducer for locating & rendering a DYNAMIC MEMORY ARRAY OF
/// DYNAMIC BYTES (`bytes[] memory`) per-pc.
///
/// Mirrors uniswap-v4-core `PoolManager.clear.t.sol`'s `bytes[] memory params`:
/// each element is itself a reference type (dynamic `bytes`), so the element
/// slot in the array's memory layout holds a memory OFFSET to the element's
/// bytes — not a value-type word. The value-type array path (`ArrayLayout` with
/// scalar element decode) can't render these, so `params` showed no value even
/// while live and in scope. The per-pc analyzer locates the array's stack slot;
/// the element-bytes layout dereferences each element as raw `bytes`.
contract BytesArray {
    uint256 public out; // slot 0

    /// Recursive so solc does NOT inline it — `p` is passed on the stack, which
    /// is what makes `run`'s array local a genuine last-use stack read.
    function consume(bytes[] memory p, uint256 depth) internal returns (uint256) {
        if (depth > 0) return consume(p, depth - 1);
        out = p.length;
        return out;
    }

    function run() external returns (uint256) {
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(uint256(0x1234)); // 32 bytes: 0x00..1234
        params[1] = hex"deadbeef"; //               4 bytes:  0xdeadbeef
        return consume(params, 1); // params read here (last use) — must be visible
    }
}
