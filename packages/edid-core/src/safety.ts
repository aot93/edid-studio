// Limits and checks for untrusted input: uploaded files and pasted text may
// come from anyone once the UI is public. Everything here runs before parsing.

import { EdidInputError } from "./errors.ts";

/** The largest possible EDID: 256 blocks of 128 bytes (base byte 126 max 255). */
export const MAX_EDID_BYTES = 256 * 128;

/**
 * Largest file or paste accepted. Generous for hex dumps of the largest EDID
 * (`hexdump -C` is about 5 characters per byte) and for pasted edid-decode
 * output, which follows its hex with a full text decode.
 */
export const MAX_INPUT_BYTES = 512 * 1024;

/** Extensions accepted for uploads. A file with no extension is accepted too. */
export const UPLOAD_EXTENSIONS: readonly string[] = ["bin", "edid", "dat", "raw", "txt", "hex", "h", "c"];

const KNOWN_TYPES: readonly { readonly magic: readonly number[]; readonly name: string }[] = [
  { magic: [0x89, 0x50, 0x4e, 0x47], name: "a PNG image" },
  { magic: [0xff, 0xd8, 0xff], name: "a JPEG image" },
  { magic: [0x47, 0x49, 0x46, 0x38], name: "a GIF image" },
  { magic: [0x25, 0x50, 0x44, 0x46], name: "a PDF document" },
  { magic: [0x50, 0x4b, 0x03, 0x04], name: "a ZIP archive (or an Office document)" },
  { magic: [0x1f, 0x8b], name: "a gzip archive" },
  { magic: [0x37, 0x7a, 0xbc, 0xaf], name: "a 7-Zip archive" },
  { magic: [0x52, 0x61, 0x72, 0x21], name: "a RAR archive" },
  { magic: [0x7f, 0x45, 0x4c, 0x46], name: "a Linux executable" },
  { magic: [0x4d, 0x5a], name: "a Windows executable" },
  { magic: [0xd0, 0xcf, 0x11, 0xe0], name: "an old Office document" },
];

/** Refuses input larger than `MAX_INPUT_BYTES`. */
export function checkInputSize(size: number): void {
  if (size > MAX_INPUT_BYTES) {
    throw new EdidInputError(
      "too-large",
      `input is ${size} bytes; the limit is ${MAX_INPUT_BYTES} (an EDID is at most ${MAX_EDID_BYTES} bytes)`,
    );
  }
}

/** Refuses common non-EDID file types by their leading bytes, with a clear name. */
export function checkKnownFileType(bytes: Uint8Array): void {
  for (const { magic, name } of KNOWN_TYPES) {
    if (magic.every((m, i) => bytes[i] === m)) {
      throw new EdidInputError("known-file-type", `this looks like ${name}, not an EDID`);
    }
  }
}

/**
 * Checks an uploaded file's name. The name is only used for messages and
 * the extension allow-list; content checks do the real work.
 */
export function checkUploadName(name: string): void {
  if (name.length === 0 || name.length > 255) {
    throw new EdidInputError("bad-file-name", "file name must be 1 to 255 characters");
  }
  // Control characters, path separators and NUL never belong in an uploaded name.
  if (/[\u0000-\u001f\u007f/\\]/.test(name)) {
    throw new EdidInputError("bad-file-name", `file name ${quoteForMessage(name)} contains a path separator or control character`);
  }
  const dot = name.lastIndexOf(".");
  if (dot > 0) {
    const ext = name.slice(dot + 1).toLowerCase();
    if (!UPLOAD_EXTENSIONS.includes(ext)) {
      throw new EdidInputError(
        "unsupported-extension",
        `.${quoteForMessage(ext, 16, false)} files are not accepted; use ${UPLOAD_EXTENSIONS.map((e) => "." + e).join(", ")} or no extension`,
      );
    }
  }
}

/**
 * Renders untrusted text for a message or a terminal: printable ASCII is
 * kept, everything else (escape sequences, NUL, non-ASCII) becomes \xNN, and
 * long text is cut. Interfaces must still insert it as text, never as HTML.
 */
export function printable(text: string, max = 64): string {
  let out = "";
  for (const ch of text.slice(0, max)) {
    const c = ch.codePointAt(0) ?? 0;
    if (ch === "\\") out += "\\\\";
    else if (c >= 0x20 && c <= 0x7e) out += ch;
    else if (c <= 0xff) out += `\\x${c.toString(16).padStart(2, "0")}`;
    else out += `\\u{${c.toString(16)}}`;
  }
  return text.length > max ? `${out}...` : out;
}

/** `printable`, in double quotes unless `quoted` is false. */
export function quoteForMessage(text: string, max = 24, quoted = true): string {
  const p = printable(text, max);
  return quoted ? `"${p}"` : p;
}

/** String.fromCharCode over a large array without overflowing the call stack. */
export function charCodesToString(codes: ArrayLike<number>): string {
  let out = "";
  const CHUNK = 8192;
  for (let i = 0; i < codes.length; i += CHUNK) {
    out += String.fromCharCode(...Array.from({ length: Math.min(CHUNK, codes.length - i) }, (_, j) => codes[i + j] ?? 0));
  }
  return out;
}
