// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

/// Fixture for M7b-3c — storage reference-type decoding.
/// Exercises: a dynamic storage array, a SHORT string (<32 bytes, inline),
/// a LONG string (>=32 bytes, keccak-based), dynamic bytes, a mapping
/// (keys recoverable only via keccak-preimage enumeration from the trace),
/// a value-member storage struct, and an emitted event.
contract StorageRefs {
    struct Point {
        uint256 x;
        uint256 y;
    }

    uint256[] public arr; // slot 0 (len); elements at keccak(0)+i
    string public shortStr; // slot 1 (inline, <32 bytes)
    string public longStr; // slot 2 (len*2+1; data at keccak(2)+)
    bytes public blob; // slot 3 (dynamic bytes)
    mapping(uint256 => uint256) public balances; // slot 4; entry at keccak(key . 4)
    Point public pt; // slots 5 (x), 6 (y)

    event Updated(uint256 indexed key, uint256 value);

    function populate() public {
        arr.push(11);
        arr.push(22);
        arr.push(33);
        shortStr = "hello";
        longStr = "abcdefghijklmnopqrstuvwxyz0123456789"; // 36 bytes -> long
        blob = hex"deadbeef";
        balances[7] = 100;
        balances[9] = 250;
        pt.x = 5;
        pt.y = 6;
        emit Updated(7, 100);
    }
}
