// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice A modifier that CALLS an internal function: while `_check` runs, the
/// stack is [_check, checked, run] — the suspended modifier stays beneath it.
/// `guard` then calls `_guard` as its first statement.
contract ModCall {
    uint256 public stored;

    function _check(uint256 x) internal pure returns (bool) {
        return x > 0;
    }

    modifier checked(uint256 x) {
        require(_check(x), "zero");
        _;
    }

    function run(uint256 x) external checked(x) guard returns (uint256) {
        stored = x;
        return x + 1;
    }

    /// A modifier whose first statement is a bare call: under viaIR its code up
    /// to the call maps to the modifier header, not to the statement.
    modifier guard() {
        _guard();
        _;
    }

    function _guard() internal view {
        require(stored < type(uint256).max, "full");
    }
}
