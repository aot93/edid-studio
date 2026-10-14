// Byte diff aligned per 128-byte block, so removing one byte shows as one
// removal rather than shifting every later byte into "changed".

import { BLOCK_SIZE } from "./bytes.ts";

export interface ByteDiff {
  /** One entry per byte of `after`: true when it is new or changed. */
  readonly changed: readonly boolean[];
  /** Bytes of `before` with no counterpart in `after`. */
  readonly removed: number;
  /** Count of true entries in `changed`. */
  readonly added: number;
}

/**
 * Longest-common-subsequence alignment of each block of `before` with the
 * block at the same index in `after`. Blocks present on one side only count
 * as wholly added or removed. O(128 x 128) per block.
 */
export function byteDiff(before: ArrayLike<number>, after: ArrayLike<number>): ByteDiff {
  const changed: boolean[] = new Array<boolean>(after.length).fill(true);
  let removed = 0;
  const blocks = Math.max(before.length, after.length) / BLOCK_SIZE;
  for (let b = 0; b < blocks; b++) {
    const s = b * BLOCK_SIZE;
    const aLen = Math.max(0, Math.min(BLOCK_SIZE, before.length - s));
    const bLen = Math.max(0, Math.min(BLOCK_SIZE, after.length - s));
    // lcs[i][j]: LCS length of before[s+i..] and after[s+j..].
    const lcs = Array.from({ length: aLen + 1 }, () => new Uint16Array(bLen + 1));
    for (let i = aLen - 1; i >= 0; i--) {
      for (let j = bLen - 1; j >= 0; j--) {
        const row = lcs[i] as Uint16Array;
        const next = lcs[i + 1] as Uint16Array;
        row[j] = before[s + i] === after[s + j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
      }
    }
    let i = 0;
    let j = 0;
    let matched = 0;
    while (i < aLen && j < bLen) {
      if (before[s + i] === after[s + j]) {
        changed[s + j] = false;
        matched++;
        i++;
        j++;
      } else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) {
        i++;
      } else {
        j++;
      }
    }
    removed += aLen - matched;
  }
  return { changed, removed, added: changed.filter(Boolean).length };
}
