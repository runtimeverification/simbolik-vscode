// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

/// @notice Exercises `vm.etch` with RAW bytecode that is NOT any compiled
/// contract — there is no CBOR metadata and no matching compilation unit, so
/// the debugger cannot identify a source for the etched frame. 4b must degrade
/// such a frame to EVM-only (disassembly / raw stepping) WITHOUT mis-resolving
/// its PCs against the caller's source map and WITHOUT corrupting the parent
/// `run` frame's stepping.
interface Vm {
    function etch(address who, bytes calldata code) external;
}

contract EtchRaw {
    Vm constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);
    address constant TARGET = address(uint160(0xBEEF));

    bytes32 public out; // slot 0

    function run() external {
        // Minimal valid runtime: PUSH1 1; PUSH1 0; MSTORE; PUSH1 32; PUSH1 0;
        // RETURN → returns the 32-byte word 0x…01. No CBOR, not a known CU.
        vm.etch(TARGET, hex"600160005260206000f3");
        (bool ok, bytes memory ret) = TARGET.call("");
        require(ok, "raw call failed");
        out = abi.decode(ret, (bytes32)); // expect 0x…01
    }
}
