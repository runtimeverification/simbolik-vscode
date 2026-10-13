// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

/// @notice Exercises FIXED-size arrays (`T[N]`) in both storage and memory,
/// with full-slot (uint256) elements so no packing is involved.
///
/// Storage layout: `fixedArr` occupies slots 0,1,2 inline (no length prefix,
/// no keccak); `sum` is slot 3. A memory `uint256[3]` local is stored inline
/// with no length word — element i at base + i*32.
contract FixedArrays {
    uint256[3] public fixedArr; // slots 0,1,2 (inline)
    uint256 public sum; // slot 3

    function fill() external {
        fixedArr[0] = 111;
        fixedArr[1] = 222;
        fixedArr[2] = 333;

        uint256[3] memory local;
        local[0] = 11;
        local[1] = 22;
        local[2] = 33;

        // Use `local` so it stays live to a clean statement boundary and its
        // memory pointer is resolvable; writes a separate slot so `fixedArr`
        // keeps [111, 222, 333].
        sum = local[0] + local[1] + local[2];
    }
}
