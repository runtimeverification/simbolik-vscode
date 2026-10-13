// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

/// @notice A user-defined VALUE type (`type ... is address`), like uniswap-v4's
/// `Currency`. A local of this type must be shown in the variables view with its
/// underlying (address) value, not treated as a reference type.
type Token is address;

/// @notice Base contract holding an internal function with UDVT locals. The
/// entry contract INHERITS it — so resolving the function's locals must look past
/// the derived contract's own members (a by-name lookup scoped to the derived
/// contract would miss it and show no locals at all).
contract TokenBase {
    Token public t0; // slot 0
    Token public t1; // slot 1

    function mint(uint256 seed) internal returns (Token) {
        // A state write so the call is not optimized away.
        t0 = Token.wrap(address(uint160(seed + 1)));
        return t0;
    }

    /// A recursive helper so solc does NOT inline it — the arguments are passed on
    /// the stack, which is what forces `setupTokens`'s value-type locals to be read
    /// by a last-use SWAP (move) rather than a DUP (copy). Takes the UNWRAPPED
    /// addresses so the call site reads each local through `Token.unwrap(...)` —
    /// exactly the uniswap-v4 `MockERC20(Currency.unwrap(_currencyA))` shape.
    function order(address x, address y, uint256 depth)
        internal
        pure
        returns (Token, Token)
    {
        if (depth > 0) return order(x, y, depth - 1);
        return x < y ? (Token.wrap(x), Token.wrap(y)) : (Token.wrap(y), Token.wrap(x));
    }

    /// The reproducer body: two UDVT locals assigned from calls, then read into a
    /// multi-arg call. Under `--via-ir` a value local's LAST use is a SWAP (move),
    /// which the DUP-only read anchor missed — so `_a`/`_b` were shown without a
    /// value even once located.
    function setupTokens() internal returns (Token a, Token b) {
        Token _a = mint(0x11); // UDVT local (base-contract function)
        Token _b = mint(0x22); // UDVT local
        // _a/_b read through Token.unwrap(...) as a last-use move (SWAP).
        (a, b) = order(Token.unwrap(_a), Token.unwrap(_b), 1);
    }
}

/// @notice Entry contract: `run()` calls the INHERITED `setupTokens()`.
contract InheritedUdvt is TokenBase {
    function run() external {
        setupTokens();
    }
}
