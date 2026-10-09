// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ICallee} from "./Caller.sol";

/// @notice An EXTERNAL call made from inside an INTERNAL function: while the
/// callee runs, the caller's EVM frame must still show its internal call chain
/// (go → _forward), so stepping in/out of the callee changes the stack by one
/// frame at a time.
contract Forwarder {
    uint256 public result;

    function go(address callee, uint256 x) public {
        uint256 r = _forward(callee, x);
        result = r;
    }

    function _forward(address callee, uint256 x) internal returns (uint256) {
        uint256 r = ICallee(callee).compute(x);
        return r + 1;
    }
}
