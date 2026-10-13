// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

/// @notice Exercises MULTI-LEVEL internal calls for DAP stack reconstruction:
/// NESTED (outer → level1 → level2) and SEQUENTIAL (outer → level1, then, after
/// it returns, outer → leaf). Used to test the internal-frame pop/re-push path.
contract NestedCalls {
    uint256 public result;

    function outer(uint256 x) public returns (uint256) {
        uint256 a = level1(x); // nested: level1 calls level2
        uint256 b = leaf(x); // sequential: called after level1 returned
        result = a + b;
        return result;
    }

    function level1(uint256 y) internal returns (uint256) {
        uint256 inner = level2(y); // nested call
        return inner + 1;
    }

    function level2(uint256 z) internal returns (uint256) {
        return z * 2; // deepest frame
    }

    function leaf(uint256 w) internal returns (uint256) {
        return w + 100; // sequential sibling frame
    }
}
