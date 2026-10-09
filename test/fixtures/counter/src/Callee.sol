// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Callee {
    uint256 public stored;

    function compute(uint256 x) external returns (uint256) {
        stored = x * 2;
        return stored + 1;
    }
}
