// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

/// The subset of the Foundry cheatcode interface the exception fixtures use.
interface Vm {
    function assertEq(uint256 left, uint256 right) external pure;
    function expectRevert() external;
}

/// @notice Exception fixtures: every way a call can fail, caught and uncaught.
contract Thrower {
    error TooSmall(uint256 got, uint256 min);

    function boom() external pure {
        revert("boom");
    }

    function overflow(uint256 x) external pure returns (uint256) {
        return x + type(uint256).max;
    }

    function invalidOp() external pure {
        assembly {
            invalid()
        }
    }

    function check(uint256 x) external pure {
        if (x < 10) {
            revert TooSmall(x, 10);
        }
    }
}

contract Exceptions {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    Thrower public t;
    uint256 public reached;

    constructor() {
        t = new Thrower();
    }

    /// Three CAUGHT failures (Error(string), Panic(0x11), INVALID), then an
    /// UNCAUGHT custom error that bubbles out of the nested call.
    function mixed() external {
        try t.boom() {} catch {}
        try t.overflow(1) returns (uint256) {} catch {}
        try t.invalidOp{gas: 100000}() {} catch {}
        reached = 1;
        t.check(3);
        reached = 2;
    }

    /// An uncaught `require` failing in the entry function itself.
    function direct(uint256 x) external {
        reached = x;
        require(x > 5, "x too small");
    }

    /// A failing `vm.assertEq` cheatcode.
    function assertion() external {
        reached = 1;
        vm.assertEq(reached, 2);
    }

    /// An expected revert: `vm.expectRevert` turns the revert into success.
    function expected() external {
        vm.expectRevert();
        t.boom();
        reached = 3;
    }
}
