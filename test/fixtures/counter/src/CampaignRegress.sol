// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// Regression fixture distilled from the viaIR-vs-legacy differential campaign
/// over uniswap-v4-core (see packages/debugger/test/campaign-regress.test.ts).
/// Called as `run(3, 5)`: lo = 3, hi = 4, z = false, acc = -15, picked = -15,
/// d = 8. Each construct reproduces a bug class that campaign found.
contract CampaignRegress {
    bool private unlocked = true;
    uint256 public stored;

    modifier whenUnlocked() {
        require(unlocked, "locked");
        _;
    }

    /// One-statement helper: step-into must stop on its only statement.
    function isZero(uint256 v) internal pure returns (bool) {
        return v == 0;
    }

    /// Tuple-returning helper: its results initialise two locals at once.
    function pair(uint256 a) internal pure returns (uint256 lo, uint256 hi) {
        lo = a;
        hi = a + 1;
    }

    /// Called through a function pointer (an indirect internal call).
    function twice(uint256 a) internal pure returns (uint256) {
        return a * 2;
    }

    /// A modified function: step-over from the modifier must enter the body.
    function guarded(uint256 x) public whenUnlocked returns (uint256) {
        stored = x;
        return x + 1;
    }

    function run(uint256 n, int256 step) external returns (int256) {
        (uint256 lo, uint256 hi) = pair(n);
        bool z = isZero(lo);
        int256 acc = 0;
        for (uint256 i = 0; i < n; i++) {
            acc -= step;
        }
        int256 picked = z ? int256(hi) : acc;
        function(uint256) internal pure returns (uint256) f = twice;
        uint256 d = f(hi);
        guarded(d);
        return picked + acc + int256(d);
    }
}
