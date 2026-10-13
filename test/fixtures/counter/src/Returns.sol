// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Returns {
    uint256 public stored;

    function calc(uint256 x) public returns (uint256 doubled, uint256 tripled) {
        doubled = x * 2;
        uint256 tmp = helper(x);
        tripled = tmp + x;
        stored = doubled + tripled;
    }

    function helper(uint256 y) internal returns (uint256 out) {
        uint256 local = y + 1;
        out = local * 2;
        return out;
    }
}
