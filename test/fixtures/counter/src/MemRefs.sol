// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

/// @notice Dual-pipeline reproducer for MEMORY reference-type locals: a dynamic
/// value array (`uint256[]`), a `string`, and a fixed-size memory array
/// (`uint256[3]`). Recorded BOTH viaIR and legacy so the variables-view
/// rendering of memory references is proven on each pipeline — the per-pc
/// stack-provenance path (viaIR, reordered/reused slots) AND the legacy
/// frame-relative slot model.
///
/// The locals are passed into a RECURSIVE (non-inlined) `consume`, so each is a
/// genuine last-use stack read (a tagged Identifier read the provenance analyzer
/// can anchor) — mirroring BytesArray / MemStruct.
contract MemRefs {
    uint256 public out; // slot 0

    function consume(
        uint256[] memory nums,
        string memory label,
        uint256[3] memory fixed3,
        uint256 depth
    ) internal returns (uint256) {
        if (depth > 0) return consume(nums, label, fixed3, depth - 1);
        out = nums.length + bytes(label).length + fixed3[2];
        return out;
    }

    function run() external returns (uint256) {
        uint256[] memory nums = new uint256[](2);
        nums[0] = 11;
        nums[1] = 22;
        string memory label = "hi";
        uint256[3] memory fixed3 = [uint256(101), 202, 303];
        return consume(nums, label, fixed3, 1); // read here (last use) — must be visible
    }
}
