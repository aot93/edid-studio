/** Size of every EDID block in bytes (VESA E-EDID 1.4, section 3). */
export const EDID_BLOCK_SIZE = 128;

/** Expected total length of an EDID with the given number of extension blocks. */
export function expectedEdidLength(extensionCount: number): number {
  return EDID_BLOCK_SIZE * (1 + extensionCount);
}
