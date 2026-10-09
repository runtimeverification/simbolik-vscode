// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice A function with TWO modifiers, entered by an internal call and by an
/// external one. Step-into stops at each modifier invocation in the header
/// before entering that modifier, so every step-in pushes at most one frame.
contract MultiMod {
    bool private unlocked = true;
    uint256 public stored;

    modifier whenUnlocked() {
        require(unlocked, "locked");
        _;
    }

    modifier atLeast(uint256 x, uint256 min) {
        require(x >= min, "too small");
        _;
    }

    function run(uint256 x) external returns (uint256) {
        uint256 a = guarded(x);
        uint256 b = this.guarded(x + 1);
        return a + b;
    }

    function guarded(uint256 x) public whenUnlocked atLeast(x, 1) returns (uint256) {
        stored = x;
        return x + 1;
    }
}
