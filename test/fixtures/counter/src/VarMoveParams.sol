// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

/// @notice viaIR reproducer for value-type PARAMETER stack locations.
/// `probe(p, q)` takes two value params, derives a local, and uses all three
/// across multi-arg abi.encode expressions that make the Yul stack scheduler
/// reorder slots. Reading `p`/`q`/`s` mid-function must return their true values.
contract VarMoveParams {
    uint256 public out; // slot 0

    function probe(uint256 p, uint256 q) external returns (uint256) {
        uint256 s = p + q; // local derived from params
        bytes memory e0 = abi.encode(p, q, s, address(this));
        bytes memory e1 = abi.encode(q, p, false, "");
        out = p + q + s + e0.length + e1.length; // params + local used again, late
        return out;
    }
}
