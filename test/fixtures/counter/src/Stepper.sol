// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Stepper {
    uint256 public total;

    function run(uint256 x) public {
        uint256 a = x + 1;
        uint256 b = double(a);
        total = a + b;
    }

    function double(uint256 v) internal pure returns (uint256) {
        return v * 2;
    }
}
