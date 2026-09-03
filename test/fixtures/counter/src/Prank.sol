// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

/// @notice Exercises the `vm.startPrank` cheatcode so we can see what
/// kontrol-node emits for `msg.sender` in the PRANKED callee frame.
///
/// `vm.startPrank(who)` changes the `msg.sender` observed by the *callee* of
/// each subsequent external call (not within the pranking frame itself). So
/// `Target.record()` — called after the prank — should observe `who` as its
/// `msg.sender`, and the trace's per-step `msgSender` inside Target's frame
/// should be `who`, not the Prank contract's address.
interface Vm {
    function startPrank(address who) external;
    function stopPrank() external;
}

contract Target {
    address public seen;

    function record() external returns (address) {
        seen = msg.sender; // should be the pranked address while pranking
        return seen;
    }
}

contract Prank {
    Vm constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    address public seenBefore; // msg.sender at Target before the prank
    address public seenDuring; // msg.sender at Target during the prank

    function run(address who) external {
        Target target = new Target();

        seenBefore = target.record(); // no prank → should be this contract

        vm.startPrank(who);
        seenDuring = target.record(); // pranked → should be `who`
        vm.stopPrank();
    }
}
