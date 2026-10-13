// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

/// @notice Spike fixture: force solc to REORDER a value-type local's stack slot.
/// `amount` is declared first, then used across several multi-arg abi.encode
/// expressions (the pattern that moved `amount` off its declaration slot in
/// uniswap-v4-core). If the height+rank location model is wrong, reading
/// `amount` mid-function returns a stray value.
contract VarMove {
    uint256 public out; // slot 0

    function run() external {
        uint256 amount = 7; // value local (declared first)
        uint256[] memory a = new uint256[](2); // array alloc reshuffles the stack
        bytes memory p0 = abi.encode(a.length, amount, address(this));
        bytes memory p1 = abi.encode(amount, uint256(9), false, "");
        out = amount + a.length + p0.length + p1.length; // amount used again
    }
}
