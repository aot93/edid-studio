// Import and export entry points: binary, hex text in any common layout
// (C arrays included), and base64. No Windows .reg overrides: the app never
// writes to a machine (SPEC.md section 13).

import { EDID_HEADER, manufacturerId } from "./base-block.ts";
import { bytesEqual, slice } from "./bytes.ts";
import { assertExportable, checksumErrors, parseEdid, serializeEdid } from "./edid.ts";
import { EdidInputError, EdidParseError } from "./errors.ts";
import { DEFAULT_HEX_STYLE, formatHex, parseHex } from "./hex.ts";
import type { HexStyle } from "./hex.ts";
import type { Edid } from "./model.ts";
import { charCodesToString, checkInputSize, checkKnownFileType, checkUploadName, MAX_EDID_BYTES } from "./safety.ts";

export interface ImportedEdid {
  readonly edid: Edid;
  /** The bytes as read, before any re-serialization. */
  readonly bytes: Uint8Array;
  readonly format: "binary" | "hex" | "base64";
  /** Layout of hex input, so an export can mirror it. */
  readonly hexStyle: HexStyle;
  /** Blocks whose checksum is wrong in the input. Export always rewrites them. */
  readonly checksumErrors: readonly string[];
}

/**
 * Reads an EDID from a binary buffer or from hex text in any common layout.
 * A buffer that starts with the EDID header is binary; any other buffer is
 * read as text (ASCII, UTF-8 with BOM, or UTF-16 as Windows editors save).
 *
 * Input is treated as untrusted: size is capped before any work, known
 * non-EDID file types are named and refused, and every failure is an
 * `EdidParseError` (or its subclass `EdidInputError`).
 */
export function importEdid(input: Uint8Array | string): ImportedEdid {
  checkInputSize(input.length);
  if (typeof input !== "string" && input.length >= 8 && bytesEqual(slice(input, 0, 8), EDID_HEADER)) {
    return finish(input, "binary", DEFAULT_HEX_STYLE);
  }
  if (typeof input !== "string") checkKnownFileType(input);
  const text = typeof input === "string" ? input : bufferToText(input);
  // Hex digits are valid base64 too, so base64 is recognised by its encoded EDID header.
  if (text.trimStart().startsWith(BASE64_HEADER)) return finish(parseBase64(text), "base64", DEFAULT_HEX_STYLE);
  const { bytes, style } = parseHex(text);
  return finish(bytes, "hex", style);
}

/** Reads an uploaded file: checks its name, then imports its content as `importEdid` does. */
export function importUpload(file: { readonly name: string; readonly bytes: Uint8Array }): ImportedEdid {
  checkUploadName(file.name);
  return importEdid(file.bytes);
}

/** 00 ff ff ff ff ff ff 00 in base64. */
const BASE64_HEADER = "AP///////wA";

function parseBase64(text: string): Uint8Array {
  const clean = text.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 === 1) {
    throw new EdidParseError("input starts like base64 but holds characters or a length base64 does not allow");
  }
  if ((clean.length * 3) / 4 > MAX_EDID_BYTES + 3) {
    throw new EdidInputError("too-many-bytes", `base64 input decodes to more than ${MAX_EDID_BYTES} bytes, the largest EDID`);
  }
  const body = clean.replace(/=+$/, "");
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const ch of body) {
    acc = (acc << 6) | BASE64.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = [18, 12, 6, 0].map((s) => BASE64[(n >> s) & 63] ?? "");
    const pad = i + 1 >= bytes.length ? 2 : i + 2 >= bytes.length ? 1 : 0;
    out += chars.slice(0, 4 - pad).join("") + "=".repeat(pad);
  }
  return out;
}

function finish(bytes: Uint8Array, format: ImportedEdid["format"], hexStyle: HexStyle): ImportedEdid {
  return { edid: parseEdid(bytes), bytes, format, hexStyle, checksumErrors: checksumErrors(bytes) };
}

function bufferToText(buf: Uint8Array): string {
  let units: number[];
  const utf16le = buf[0] === 0xff && buf[1] === 0xfe;
  if (utf16le || (buf[0] === 0xfe && buf[1] === 0xff)) {
    units = [];
    for (let i = 2; i + 1 < buf.length; i += 2) {
      const lo = buf[utf16le ? i : i + 1] ?? 0;
      const hi = buf[utf16le ? i + 1 : i] ?? 0;
      units.push(lo | (hi << 8));
    }
  } else {
    const start = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0;
    units = Array.from(buf.subarray(start));
  }
  const bad = units.findIndex((c) => c > 0x7e || (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d));
  if (bad !== -1) {
    throw new EdidInputError(
      "not-text",
      `input is neither a binary EDID (no 00 ff ff ff ff ff ff 00 header) nor hex text ` +
        `(unexpected byte 0x${(units[bad] ?? 0).toString(16).padStart(2, "0")} at position ${bad})`,
    );
  }
  return charCodesToString(units);
}

export type ExportFormat = "binary" | "hex" | "c" | "base64";

/** C array layout: eight bytes a line, "0x" prefixes, a trailing comma on each line. */
const C_ARRAY_STYLE: HexStyle = { uppercase: false, prefix: "0x", separator: ", ", bytesPerLine: 8, trailingSeparator: true, blankLineBetweenBlocks: false };

/** Serializes and formats an EDID. Throws `EdidExportError` if the guard fails. */
export function exportEdid(edid: Edid, format: "binary"): Uint8Array;
export function exportEdid(edid: Edid, format: "hex", style?: HexStyle): string;
export function exportEdid(edid: Edid, format: "c" | "base64"): string;
export function exportEdid(edid: Edid, format: ExportFormat, style?: HexStyle): Uint8Array | string;
export function exportEdid(edid: Edid, format: ExportFormat, style: HexStyle = DEFAULT_HEX_STYLE): Uint8Array | string {
  const bytes = serializeEdid(edid);
  assertExportable(bytes);
  switch (format) {
    case "binary":
      return bytes;
    case "hex":
      return formatHex(bytes, style);
    case "c": {
      const body = formatHex(bytes, C_ARRAY_STYLE).trimEnd().split("\n").map((l) => `  ${l}`).join("\n");
      return `unsigned char edid[${bytes.length}] = {\n${body}\n};\n`;
    }
    case "base64":
      return `${toBase64(bytes)}\n`;
  }
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/**
 * A safe file name for downloading `edid`. Built from the monitor name
 * descriptor (untrusted text) or else the manufacturer ID and product code,
 * reduced to letters, digits, "-", "_" and ".", at most 64 characters, and
 * never a Windows reserved device name. NVIDIA Control Panel loads any
 * extension; ".txt" matches what it exports.
 */
export function downloadFileName(edid: Edid, format: ExportFormat): string {
  const name = edid.base.descriptors.find((d) => d.kind === "text" && d.tag === 0xfc);
  const raw =
    name?.kind === "text"
      ? name.text
      : `${manufacturerId(edid.base.manufacturerCode)}-${edid.base.productCode.toString(16).padStart(4, "0")}`;
  let stem = raw
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 64)
    .replace(/[-.]+$/, "");
  if (stem === "" || WINDOWS_RESERVED.test(stem.split(".")[0] ?? "")) stem = `edid-${stem}`.replace(/-$/, "");
  const ext: Record<ExportFormat, string> = { binary: "bin", hex: "txt", c: "h", base64: "b64" };
  return `${stem}.${ext[format]}`;
}
