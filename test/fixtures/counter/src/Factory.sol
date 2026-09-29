// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice `new Derived(4)`: Derived's constructor body is empty — its only code
/// is the base-constructor invocation `Base(x + 1)` — so the first statement of
/// the new frame lies in Base's constructor. Step-into must enter
/// Derived.constructor (at the invocation) and Base.constructor one at a time.
contract Base {
    uint256 public v;

    constructor(uint256 x) {
        v = x;
    }
}

contract Derived is Base {
    constructor(uint256 x) Base(x + 1) {}
}

contract Factory {
    Derived public d;

    function make() external {
        d = new Derived(4);
    }
}
