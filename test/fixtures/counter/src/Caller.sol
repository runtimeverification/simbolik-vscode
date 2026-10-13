// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ICallee {
    function compute(uint256 x) external returns (uint256);
}

contract Caller {
    uint256 public result;

    function go(address callee, uint256 x) public {
        uint256 r = ICallee(callee).compute(x);
        result = r;
    }
}
