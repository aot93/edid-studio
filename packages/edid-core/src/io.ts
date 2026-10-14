// Import and export entry points. Base64, C array and .reg output arrive with
// the CLI `convert` command (milestone M3).

import { EDID_HEADER } from "./base-block.ts";
import { bytesEqual, slice } from "./bytes.ts";
import { assertExportable, checksumErrors, parseEdid, serializeEdid } from "./edid.ts";
import { EdidParseError } from "./errors.ts";
import { DEFAULT_HEX_STYLE, formatHex, parseHex } from "./hex.ts";
import type { HexStyle } from "./hex.ts";
import type { Edid } from "./model.ts";

export interface ImportedEdid {
  readonly edid: Edid;
  /** The bytes as read, before any re-serialization. */
  readonly bytes: Uint8Array;
  readonly format: "binary" | "hex";
  /** Layout of hex input, so an export can mirror it. */
  readonly hexStyle: HexStyle;
  /** Blocks whose checksum is wrong in the input. Export always rewrites them. */
  readonly checksumErrors: readonly string[];
}

/**
 * Reads an EDID from a binary buffer or from hex text in any common layout.
 * A buffer that starts with the EDID header is binary; any other buffer is
 * read as text (ASCII, UTF-8 with BOM, or UTF-16 LE as Windows editors save).
 */
export function importEdid(input: Uint8Array | string): ImportedEdid {
  if (typeof input !== "string" && input.length >= 8 && bytesEqual(slice(input, 0, 8), EDID_HEADER)) {
    return finish(input, "binary", DEFAULT_HEX_STYLE);
  }
  const text = typeof input === "string" ? input : bufferToText(input);
  const { bytes, style } = parseHex(text);
  return finish(bytes, "hex", style);
}

function finish(bytes: Uint8Array, format: "binary" | "hex", hexStyle: HexStyle): ImportedEdid {
  return { edid: parseEdid(bytes), bytes, format, hexStyle, checksumErrors: checksumErrors(bytes) };
}

function bufferToText(buf: Uint8Array): string {
  let units: number[];
  if (buf[0] === 0xff && buf[1] === 0xfe) {
    units = [];
    for (let i = 2; i + 1 < buf.length; i += 2) units.push((buf[i] ?? 0) | ((buf[i + 1] ?? 0) << 8));
  } else {
    const start = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0;
    units = Array.from(buf.subarray(start));
  }
  const bad = units.findIndex((c) => c > 0x7e || (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d));
  if (bad !== -1) {
    throw new EdidParseError(
      `input is neither a binary EDID (no 00 ff ff ff ff ff ff 00 header) nor hex text ` +
        `(unexpected byte 0x${(units[bad] ?? 0).toString(16).padStart(2, "0")} at position ${bad})`,
    );
  }
  return String.fromCharCode(...units);
}

export type ExportFormat = "binary" | "hex";

/** Serializes and formats an EDID. Throws `EdidExportError` if the guard fails. */
export function exportEdid(edid: Edid, format: "binary"): Uint8Array;
export function exportEdid(edid: Edid, format: "hex", style?: HexStyle): string;
export function exportEdid(edid: Edid, format: ExportFormat, style: HexStyle = DEFAULT_HEX_STYLE): Uint8Array | string {
  const bytes = serializeEdid(edid);
  assertExportable(bytes);
  return format === "binary" ? bytes : formatHex(bytes, style);
}
