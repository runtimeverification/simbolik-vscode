// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice The entry function's body STARTS with a bare call. Under viaIR its
/// code up to that call maps to the function header, so no statement starts
/// before `_bump`'s: the launch stop must still be `run` on line 16, not inside
/// `_bump`.
contract CallFirst {
    uint256 public n;

    function _bump() internal {
        n += 1;
    }

    function run() external {
        _bump();
        n += 2;
    }
}
