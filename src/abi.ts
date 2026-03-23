import {
  ContractDefinition,
  Expression,
  ExpressionStatement,
  FunctionCall,
  FunctionDefinition,
} from '@solidity-parser/parser/dist/src/ast-types';

import {
  address,
  array,
  bool,
  bytes,
  fixedBytes,
  fn,
  getTupleElements,
  number,
  string,
  tuple,
} from '@metamask/abi-utils/dist/parsers';
import * as parser from '@solidity-parser/parser';

/**
 * ABI encode a Solidity expression `input` of type `type`.
 *
 * @param type The Solidity type of the input parameters, e.g. `uint256`, `address[]`, `(uint256, bool)`, etc.
 * @param input The input parameters in Solidity literal syntax, e.g. `42`, `0x1234`, `(42, true)`, etc.
 * @returns The ABI-encoded input parameters as a hex string with `0x` prefix.
 * @throws If the input parameters cannot be parsed or do not match the expected type.
 */
export function abiEncode(type: string, input: string): string {
  try {
    const trimmed = input.trim();
    const parseInput = tuple.isType(type) ? trimmed.slice(1, -1) : input;
    const normalized = normalize(parse(parseInput), type);
    if (normalized === undefined) {
      throw new Error();
    }
    const encoded = tuple.encode({
      type: type,
      value: normalized as unknown[],
      buffer: new Uint8Array(),
      packed: false,
      tight: false,
    });
    return uint8ArrayToHex(encoded);
  } catch (e) {
    throw new Error('Failed to parse input parameters: ' + e);
  }
}

/**
 * We expect the user to provide function parameters in Solidity syntax.
 * The metamask abi encoder expects a different syntax.
 *
 * This function normalizes the user input to match the expected syntax of the abi encoder.
 */
type NormalizedValue = bigint | boolean | string | NormalizedValue[];

function normalize(value: Param, type: string): NormalizedValue | undefined {
  if (address.isType(type)) {
    if (typeof value === 'bigint') {
      return '0x' + value.toString(16).padStart(40, '0');
    }
    return undefined;
  } else if (string.isType(type)) {
    if (typeof value === 'string') {
      return value;
    }
    return undefined;
  } else if (array.isType(type)) {
    if (Array.isArray(value)) {
      const innerType = type.slice(0, type.lastIndexOf('['));
      const normalizedElements = value.map(v => normalize(v, innerType));
      if (normalizedElements.every(e => e !== undefined)) {
        return normalizedElements as NormalizedValue[];
      }
    }
    return undefined;
  } else if (bool.isType(type)) {
    if (typeof value === 'boolean') {
      return value;
    }
    return undefined;
  } else if (bytes.isType(type)) {
    if (typeof value === 'bigint') {
      const hex = value.toString(16);
      return '0x' + (hex.length % 2 === 0 ? hex : '0' + hex);
    } else if (value instanceof Uint8Array) {
      return (
        '0x' +
        Array.from(value)
          .map(b => b.toString(16).padStart(2, '0'))
          .join('')
      );
    }
    return undefined;
  } else if (fixedBytes.isType(type)) {
    const byteLength = parseInt(type.slice(5));
    if (typeof value === 'bigint') {
      return '0x' + value.toString(16).padStart(byteLength * 2, '0');
    } else if (value instanceof Uint8Array) {
      if (value.length !== byteLength) {
        return undefined;
      }
      return (
        '0x' +
        Array.from(value)
          .map(b => b.toString(16).padStart(2, '0'))
          .join('')
      );
    }
    return undefined;
  } else if (fn.isType(type)) {
    return undefined; // Not supported as input parameter
  } else if (number.isType(type)) {
    if (typeof value === 'bigint') {
      return value;
    }
    return undefined;
  } else if (tuple.isType(type)) {
    if (Array.isArray(value)) {
      const innerTypes = getTupleElements(type);
      if (innerTypes.length !== value.length) {
        return undefined;
      }
      const normalizedElements = value.map((v, i) =>
        normalize(v, innerTypes[i])
      );
      if (normalizedElements.every(e => e !== undefined)) {
        return normalizedElements as NormalizedValue[];
      }
    }
    return undefined;
  }
  return undefined;
}

type Param = bigint | string | boolean | Uint8Array | Param[];

function parse(input: string): Param[] {
  const parsed = parser.parse(`
    contract Dummy {
      function dummy() {
        foo(${input});
      }
    }
  `);
  const contract = parsed.children[0] as ContractDefinition;
  const method = contract.subNodes[0] as FunctionDefinition;
  const stmt = method.body!.statements[0]! as ExpressionStatement;
  const call = stmt.expression! as FunctionCall;
  const args = call.arguments;
  const result = args.map(arg => toParam(arg as Expression));
  return result;
}

function toParam(expr: Expression): Param {
  switch (expr.type) {
    case 'TupleExpression':
      return expr.components.map(e => toParam(e as Expression));
    case 'NumberLiteral':
      if (expr.subdenomination) {
        const base = BigInt(expr.number);
        const factor = denominationMap[expr.subdenomination]!;
        return base * factor;
      }
      return BigInt(expr.number);
    case 'BooleanLiteral':
      return expr.value;
    case 'StringLiteral':
      return expr.value;
    case 'HexLiteral': {
      const hex = expr.value;
      const paddedHex = hex.length % 2 === 0 ? hex : '0' + hex;
      const result = new Uint8Array(paddedHex.length / 2);
      for (let i = 0; i < result.length; i++) {
        result[i] = parseInt(paddedHex.slice(i * 2, i * 2 + 2), 16);
      }
      return result;
    }
    case 'UnaryOperation':
      if (expr.operator === '-') {
        const operand = toParam(expr.subExpression as Expression);
        if (typeof operand === 'bigint') {
          return -operand;
        }
      }
      throw new Error();
    default:
      throw new Error();
  }
}

const denominationMap: {[key: string]: bigint} = {
  wei: 1n,
  kwei: 1000n,
  ada: 1000n,
  femtoether: 1000n,
  mwei: 1000000n,
  babbage: 1000000n,
  picoether: 1000000n,
  gwei: 1000000000n,
  shannon: 1000000000n,
  nanoether: 1000000000n,
  nano: 1000000000n,
  szabo: 1000000000000n,
  microether: 1000000000000n,
  micro: 1000000000000n,
  finney: 1000000000000000n,
  milliether: 1000000000000000n,
  milli: 1000000000000000n,
  ether: 1000000000000000000n,
  kether: 1000000000000000000000n,
  grand: 1000000000000000000000n,
  einstein: 1000000000000000000000n,
  mether: 1000000000000000000000000n,
  gether: 1000000000000000000000000000n,
  tether: 1000000000000000000000000000000n,
};

function uint8ArrayToHex(bytes: Uint8Array<ArrayBufferLike>): string {
  return (
    '0x' +
    Array.from(bytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
  );
}
