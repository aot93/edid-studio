import { EDID_HEADER, parseBaseBlock, serializeBaseBlock } from "./base-block.ts";
import { BLOCK_SIZE, blockChecksum, blockSum, byteAt, bytesEqual, slice } from "./bytes.ts";
import { eeodbCountInBlock, hfEeodbBlockCount, parseCtaExtension, serializeCtaExtension } from "./cta.ts";
import { EdidExportError, EdidParseError } from "./errors.ts";
import type { Edid, Extension } from "./model.ts";

/** Expected total length for an EDID with `extensionCount` extension blocks. */
export function expectedEdidLength(extensionCount: number): number {
  return BLOCK_SIZE * (1 + extensionCount);
}

/**
 * Extension count the bytes declare: base byte 126, or the HDMI Forum EEODB
 * count when byte 126 is 1 and block 1 carries an EEODB (edid-decode
 * check_base_block()).
 */
export function declaredExtensionCount(bytes: ArrayLike<number>): number {
  const flag = byteAt(bytes, 126);
  if (flag === 1) {
    const eeodb = hfEeodbBlockCount(bytes);
    if (eeodb !== undefined) return eeodb;
  }
  return flag;
}

/** Problems that make bytes unfit to read or export. Empty when the bytes are sound. */
export function structuralProblems(bytes: ArrayLike<number>): string[] {
  const problems: string[] = [];
  if (bytes.length < BLOCK_SIZE || bytes.length % BLOCK_SIZE !== 0) {
    problems.push(`EDID is ${bytes.length} bytes; the length must be a whole number of 128-byte blocks`);
    return problems;
  }
  if (!bytesEqual(slice(bytes, 0, 8), EDID_HEADER)) {
    problems.push("block 0 does not start with the EDID header 00 ff ff ff ff ff ff 00");
    return problems;
  }
  const extensions = declaredExtensionCount(bytes);
  const expected = expectedEdidLength(extensions);
  if (bytes.length !== expected) {
    problems.push(
      `EDID is ${bytes.length} bytes, but it declares ${extensions} extension block(s), ` +
        `so it must be 128 x (1 + ${extensions}) = ${expected} bytes`,
    );
  }
  return problems;
}

function checksumProblems(bytes: ArrayLike<number>): string[] {
  const problems: string[] = [];
  for (let i = 0; i < bytes.length / BLOCK_SIZE; i++) {
    const sum = blockSum(bytes, i);
    if (sum !== 0) {
      const found = byteAt(bytes, i * BLOCK_SIZE + BLOCK_SIZE - 1);
      const want = blockChecksum(slice(bytes, i * BLOCK_SIZE, (i + 1) * BLOCK_SIZE));
      problems.push(`block ${i} checksum is ${hex(found)}, should be ${hex(want)}`);
    }
  }
  return problems;
}

/**
 * The export guard (SPEC.md, section 5): refuses bytes whose length is not
 * 128 x (1 + extension count) or whose blocks do not each sum to zero.
 */
export function assertExportable(bytes: ArrayLike<number>): void {
  const problems = structuralProblems(bytes);
  if (problems.length === 0) problems.push(...checksumProblems(bytes));
  if (problems.length > 0) {
    throw new EdidExportError(`export refused: ${problems.join("; ")}`);
  }
}

/** Per-block checksum problems, for reporting on imported files. */
export function checksumErrors(bytes: ArrayLike<number>): string[] {
  return checksumProblems(bytes);
}

/**
 * Parses EDID bytes into the model. Refuses input with a wrong length or
 * header. Checksums are not required to be correct here (an imported file
 * may be broken and still worth diagnosing); `serializeEdid` always writes
 * correct ones.
 */
export function parseEdid(bytes: ArrayLike<number>): Edid {
  const problems = structuralProblems(bytes);
  if (problems.length > 0) throw new EdidParseError(problems.join("; "));

  const blockCount = bytes.length / BLOCK_SIZE;
  const base = parseBaseBlock(slice(bytes, 0, BLOCK_SIZE - 2));
  const extensions: Extension[] = [];
  for (let i = 1; i < blockCount; i++) {
    const block = slice(bytes, i * BLOCK_SIZE, (i + 1) * BLOCK_SIZE - 1);
    extensions.push(parseCtaExtension(block) ?? { kind: "raw", bytes: block });
  }
  return { base, extensions };
}

/** Serializes the model to bytes. The only code that produces EDID bytes. */
export function serializeEdid(edid: Edid): Uint8Array {
  const extensions = edid.extensions.map((ext) =>
    ext.kind === "cta" ? serializeCtaExtension(ext) : rawExtension(ext.bytes),
  );
  const base = [...serializeBaseBlock(edid.base), extensionFlag(extensions)];
  const blocks = [base, ...extensions];
  const out = new Uint8Array(blocks.length * BLOCK_SIZE);
  blocks.forEach((block, i) => {
    out.set([...block, blockChecksum([...block, 0])], i * BLOCK_SIZE);
  });
  assertExportable(out);
  return out;
}

/**
 * Base byte 126. When block 1 carries an HDMI Forum EEODB it is 1 and the
 * EEODB holds the real count.
 */
function extensionFlag(extensions: readonly (readonly number[])[]): number {
  const first = extensions[0];
  if (first !== undefined && eeodbCountInBlock(first) !== undefined) return 1;
  if (extensions.length > 255) {
    throw new EdidExportError(`export refused: ${extensions.length} extension blocks exceed 255`);
  }
  return extensions.length;
}

function rawExtension(bytes: readonly number[]): number[] {
  if (bytes.length !== BLOCK_SIZE - 1) {
    throw new EdidExportError(`export refused: raw extension is ${bytes.length} bytes, expected 127`);
  }
  return [...bytes];
}

function hex(v: number): string {
  return v.toString(16).padStart(2, "0");
}
