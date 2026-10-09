// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

/// @notice Exercises a MODIFIER for DAP stack reconstruction. Paused inside the
/// modifier body (pre-placeholder) the stack should show [onlyPositive, bump];
/// paused inside the function body (after `_;`) it should show [bump] with the
/// modifier suspended.
contract Modifiers {
    uint256 public stored;

    modifier onlyPositive(uint256 x) {
        uint256 doubled = x * 2; // modifier-body local, pre-placeholder
        require(doubled > 0, "not positive");
        _; // placeholder → runs the function body
    }

    function bump(uint256 x) public onlyPositive(x) returns (uint256 r) {
        r = x + 1; // function body (modifier suspended here)
        stored = r;
    }
}
