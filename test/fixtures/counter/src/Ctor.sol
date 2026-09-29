// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Locals in constructor (INIT) code. `CtorFactory.run()` does
/// `new Ctor(5, 7)`, which runs, in one init-code frame:
///  - Ctor's constructor params `a`, `b` (ABI-decoded from the END of the init
///    code — CODECOPY'd into memory, not read from calldata),
///  - the base constructor `CtorBase(b)`, inlined, with its own param + local,
///  - an internal call `_scale` whose init-code copy differs from the runtime
///    copy that `rescale` uses.
/// Expected: b=7 → doubled=14 → baseVal=14; sum=12; _scale(12): k=3, y=36 →
/// scaled=36 → total=36.
contract CtorBase {
    uint256 public baseVal;

    constructor(uint256 b) {
        uint256 doubled = b * 2;
        baseVal = doubled;
    }
}

contract Ctor is CtorBase {
    uint256 public total;
    address public owner;

    constructor(uint256 a, uint256 b) CtorBase(b) {
        uint256 sum = a + b;
        uint256 scaled = _scale(sum);
        total = scaled;
        owner = msg.sender;
    }

    function rescale(uint256 x) external {
        total = _scale(x);
    }

    function _scale(uint256 x) internal pure returns (uint256 y) {
        uint256 k = 3;
        y = x * k;
    }
}

contract CtorFactory {
    Ctor public c;

    function run() external {
        c = new Ctor(5, 7);
    }
}
