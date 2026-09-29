// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice `_fail` never returns (it always reverts), so viaIR calls it with a
/// plain JUMP — no source-map `jump:'i'`. The stack inside it must still be
/// [_fail, check, run]: the callee must not REPLACE its caller.
contract NoReturn {
    function _fail(uint256 x) internal pure {
        assembly {
            mstore(0, x)
            revert(0, 32)
        }
    }

    function check(uint256 x) internal pure returns (uint256) {
        if (x > 3) _fail(x);
        return x;
    }

    function run(uint256 x) external pure returns (uint256) {
        return check(x);
    }
}
