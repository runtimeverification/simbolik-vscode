// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

/// @notice viaIR reproducer for the "backward straight-line SETUP artifact"
/// stepping bug (mirrors uniswap-v4-core `Deployers.deployMintAndApprove2Currencies`).
///
/// `run()` calls the SAME internal function twice into two locals, then performs a
/// tuple assignment from a multi-arg internal call that uses both locals. Under
/// `--via-ir` solc lays the argument/return-slot setup out as one straight-line
/// block and attributes the tuple statement's source position to stack-setup
/// steps that PHYSICALLY PRECEDE the second local's assignment — a multi-step,
/// out-of-source-order artifact. Step-into `run()` must land on the first `mk()`
/// line (not the tuple line), and step-over from it must reach the second `mk()`
/// line (not the tuple line).
contract TwoCalls {
    uint256 public out0; // slot 0
    uint256 public out1; // slot 1

    function mk(uint256 seed) internal returns (uint256) {
        out0 += seed; // a state write so the call is not optimized away
        return seed * 2;
    }

    function order(uint256 x, uint256 y) internal pure returns (uint256, uint256) {
        return x < y ? (x, y) : (y, x);
    }

    function run() external {
        uint256 a = mk(3); // first call        (declaration line)
        uint256 b = mk(5); // second call       (declaration line)
        (out0, out1) = order(a, b); // tuple assignment from a multi-arg call
    }
}
