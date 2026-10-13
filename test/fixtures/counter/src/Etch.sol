// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

/// @notice Exercises the `vm.etch` cheatcode: it installs the RUNTIME bytecode
/// of `Impl` onto a bare address that was never deployed, then makes a real
/// external call into that address. The debugger must (a) render the `vm.etch`
/// call itself as a cheatcode frame (4a) and (b) — the point of 4b — resolve the
/// subsequent CALL frame at the etched address against the ETCHED code (Impl),
/// mapping it to Impl's source, WITHOUT corrupting the parent `run` frame.
interface Vm {
    function etch(address who, bytes calldata code) external;
}

/// The implementation whose runtime code is etched onto `TARGET`. Compiled in
/// the same unit as `Etch`, so its CBOR metadata is identifiable from build-info.
contract Impl {
    uint256 public stored;

    function setStored(uint256 v) external returns (uint256) {
        stored = v * 2; // the etched frame executes here → 21*2 = 42
        return stored;
    }
}

contract Etch {
    Vm constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    /// A bare address (never deployed) that receives Impl's code via etch.
    address constant TARGET = address(uint160(0xBEEF));

    uint256 public result; // slot 0 — should hold 42 after run()

    function run() external {
        vm.etch(TARGET, type(Impl).runtimeCode); // TARGET.code = Impl runtime
        result = Impl(TARGET).setStored(21); // step INTO etched code → 42
    }
}
