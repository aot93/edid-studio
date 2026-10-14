import { EdidEncodeError } from "./errors.ts";

export const BLOCK_SIZE = 128;

/** Reads one byte, failing loudly instead of returning undefined. */
export function byteAt(bytes: ArrayLike<number>, index: number): number {
  const value = bytes[index];
  if (value === undefined) {
    throw new RangeError(`byte ${index} is outside a ${bytes.length}-byte buffer`);
  }
  return value;
}

/** Returns bytes[start, end) as a plain array. */
export function slice(bytes: ArrayLike<number>, start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = start; i < end; i++) out.push(byteAt(bytes, i));
  return out;
}

export function bytesEqual(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function isAllZero(bytes: ArrayLike<number>): boolean {
  for (let i = 0; i < bytes.length; i++) if (bytes[i] !== 0) return false;
  return true;
}

/**
 * Checksum byte that makes the 128-byte block sum to 0 mod 256
 * (VESA E-EDID 1.4, section 3.11; CTA-861 extension byte 127).
 */
export function blockChecksum(block: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < BLOCK_SIZE - 1; i++) sum += byteAt(block, i);
  return (256 - (sum % 256)) % 256;
}

/** Sum of all 128 bytes of block `index`, mod 256. Zero for a valid block. */
export function blockSum(bytes: ArrayLike<number>, index: number): number {
  let sum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) sum += byteAt(bytes, index * BLOCK_SIZE + i);
  return sum % 256;
}

/**
 * Checks that `value` is a whole number that fits in `bits` unsigned bits and
 * returns it. The error names the field, for example
 * "horizontal front porch 1056 exceeds 1023".
 */
export function checkField(field: string, value: number, bits: number): number {
  const max = 2 ** bits - 1;
  if (!Number.isInteger(value)) {
    throw new EdidEncodeError(field, `${field} ${value} is not a whole number`);
  }
  if (value < 0) {
    throw new EdidEncodeError(field, `${field} ${value} is negative`);
  }
  if (value > max) {
    throw new EdidEncodeError(field, `${field} ${value} exceeds ${max}`);
  }
  return value;
}


/**
 * True when `encode(typed)` reproduces `source` exactly. An encoder that
 * refuses the value (a reserved code, say) counts as not reproducing it.
 */
export function reencodes<T>(typed: T, encode: (value: T) => ArrayLike<number>, source: ArrayLike<number>): boolean {
  try {
    return bytesEqual(encode(typed), source);
  } catch (e) {
    if (e instanceof EdidEncodeError) return false;
    throw e;
  }
}
