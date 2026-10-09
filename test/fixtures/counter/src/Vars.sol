// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Vars {
    enum Color { Red, Green, Blue }

    uint8 public a;        // slot 0, offset 0
    uint16 public b;       // slot 0, offset 1
    bool public flag;      // slot 0, offset 3
    address public owner;  // slot 1
    int256 public delta;   // slot 2
    bytes32 public h;      // slot 3
    Color public color;    // slot 4, offset 0

    function setAll(
        uint8 _a,
        uint16 _b,
        bool _flag,
        address _owner,
        int256 _delta,
        bytes32 _h,
        Color _color
    ) public {
        a = _a;
        b = _b;
        flag = _flag;
        owner = _owner;
        delta = _delta;
        h = _h;
        color = _color;
    }
}
