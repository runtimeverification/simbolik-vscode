// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

/// @notice Regression fixture for the step-over `combinedDepth` DRIFT bug.
///
/// `run` has three statements; statement 2 makes an EXTERNAL call that REVERTS
/// (caught by try/catch). An external function is entered via a source-map
/// `jump:'i'`, but a revert exits WITHOUT the balancing `jump:'o'` epilogue — so
/// a single global jump-fold accumulator leaks +1 and never recovers, inflating
/// every later statement's combinedDepth. Step-over from statement 1 (which
/// stops at the first statement whose combinedDepth <= the origin's) then skips
/// statement 3 and runs to the terminal step. A per-EVM-frame fold discards the
/// reverted callee's imbalance on return, so stepping stays correct.
contract Reverter {
    function boom() external pure {
        revert("boom");
    }
}

contract RevertStep {
    uint256 public a; // slot 0
    uint256 public b; // slot 1

    function run(address r) external {
        a = 1; // statement 1 (step-over origin)
        try Reverter(r).boom() {} catch {} // statement 2: reverting external call
        b = 2; // statement 3 (step-over MUST land here, not the end)
    }
}
