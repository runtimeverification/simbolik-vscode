// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

/// @notice LEGACY stepping stress. Sequential declarations, a `for` loop with a
/// back-edge, and a multi-argument internal call built from earlier locals —
/// the shapes that, under `--via-ir`, produce the out-of-order straight-line
/// SETUP artifacts the stepper suppresses via #persists / #isBackwardSetupArtifact.
///
/// Compiled LEGACY (no `--via-ir`), this fixture proves those viaIR-oriented
/// heuristics do NOT misfire on classic codegen: step-over must walk the
/// statements in SOURCE order (no false "backward fall-through" skip) and
/// step-into `combine` must land on its first line, not a later one.
contract StepStress {
    uint256 public out; // slot 0

    function combine(uint256 a, uint256 b, uint256 c) internal pure returns (uint256) {
        uint256 s = a + b; // first line of combine (step-into target)
        return s + c;
    }

    function run() external returns (uint256) {
        uint256 x = 1;
        uint256 y = 2;
        uint256 z = 3;
        uint256 sum = 0;
        for (uint256 i = 0; i < 3; i++) {
            sum += i; // loop body (back-edge to the header)
        }
        uint256 r = combine(x, y, z); // multi-arg call from earlier locals
        out = sum + r; // sum=3, r=6 → out=9
        return out;
    }
}
