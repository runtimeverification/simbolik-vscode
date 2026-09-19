// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

/// @notice Regression for two issues found stepping through Uniswap v4:
///  1. Step-INTO a 1-line EXTERNAL forwarder must land IN the forwarder, not skip
///     through it into the function it calls. Under viaIR the forwarder's call
///     argument-setup is attributed alternately to the statement and to its
///     function-declaration line before the call descends; the stepper must not
///     treat that as a setup artifact and step past the forwarder.
///  2. A `bytes calldata` PARAMETER must appear in the variables view (its data
///     lives in calldata as an offset+length pair on the stack, not in memory).
contract Inner {
    uint256 public out;

    function consume(bytes calldata data) external returns (uint256) {
        out = data.length;
        return out;
    }
}

contract Sink {
    Inner inner;

    constructor(Inner i) {
        inner = i;
    }

    /// A 1-line external forwarder: its ONLY statement is an external call.
    function forward(bytes calldata data) external returns (uint256) {
        return inner.consume(data);
    }
}

contract CalldataFwd {
    uint256 public result;

    function run() external returns (uint256) {
        Inner inner = new Inner();
        Sink sink = new Sink(inner);
        result = sink.forward(hex"deadbeefcafe"); // 6 bytes
        return result;
    }
}
