// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

/// @notice viaIR reproducer for locating a MEMORY STRUCT local per-pc.
///
/// A `memory` struct local holds a memory offset in a stack slot; the debugger
/// reads the struct's fields from memory through that slot. Under `--via-ir` the
/// slot is scheduled per-instruction (and the struct is often materialised only
/// near its use), so the legacy frame-relative slot model can't find it — the
/// variable then shows no value even while it is live and in scope. The per-pc
/// stack-provenance analyzer locates the slot instead.
struct LiqParams {
    int24 tickLower;
    int24 tickUpper;
    int128 liquidityDelta;
    bytes32 salt;
}

contract MemStruct {
    uint256 public out; // slot 0

    /// Recursive so solc does NOT inline it — `p` is passed on the stack, which is
    /// what makes `run`'s struct local a genuine last-use stack read.
    function consume(LiqParams memory p, uint256 depth) internal returns (uint256) {
        if (depth > 0) return consume(p, depth - 1);
        out = uint256(int256(p.liquidityDelta));
        return out;
    }

    function run() external returns (uint256) {
        LiqParams memory params = LiqParams({
            tickLower: int24(-120),
            tickUpper: int24(120),
            liquidityDelta: int128(1000),
            salt: bytes32(uint256(7))
        });
        return consume(params, 1); // params read here (last use) — must be visible
    }
}
