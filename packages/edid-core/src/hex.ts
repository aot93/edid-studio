// Hex text import and export. Accepts the layouts people paste: plain
// bytes, commas, 0x prefixes, C arrays, offset dumps, `hexdump -C`, `xxd`,
// one long hex string, and edid-decode's "edid-decode (hex):" section.
// Anything else on a data line is an error, never skipped silently.

import { EdidInputError, EdidParseError } from "./errors.ts";
import { MAX_EDID_BYTES, quoteForMessage } from "./safety.ts";

/** How hex text is laid out, so an export can mirror its input. */
export interface HexStyle {
  readonly uppercase: boolean;
  /** "0x" before every byte, or "". */
  readonly prefix: "" | "0x";
  /** Between bytes on a line, for example " ", ", " or "". */
  readonly separator: string;
  /** Bytes per line; 0 puts everything on one line. */
  readonly bytesPerLine: number;
  /** Put the separator after the last byte of each line too (C arrays). */
  readonly trailingSeparator: boolean;
  /** Blank line between 128-byte blocks. */
  readonly blankLineBetweenBlocks: boolean;
}

export const DEFAULT_HEX_STYLE: HexStyle = {
  uppercase: false,
  prefix: "",
  separator: " ",
  bytesPerLine: 16,
  trailingSeparator: false,
  blankLineBetweenBlocks: false,
};

/**
 * One line of lowercase bytes separated by spaces: the layout of the
 * owner's Tessera .txt files, which the NVIDIA Control Panel loads.
 * TODO(verify): confirm against a file exported by the NVIDIA Control Panel.
 */
export const ONE_LINE_HEX_STYLE: HexStyle = {
  uppercase: false,
  prefix: "",
  separator: " ",
  bytesPerLine: 0,
  trailingSeparator: false,
  blankLineBetweenBlocks: false,
};

export interface ParsedHex {
  readonly bytes: Uint8Array;
  readonly style: HexStyle;
}

const HEXDUMP_C = /^[0-9a-f]{8}\s+((?:[0-9a-f]{2}\s+)*[0-9a-f]{2})\s+\|.*\|\s*$/i;
const XXD = /^[0-9a-f]{7,8}: ([0-9a-f ]{1,40})(?: .*)?$/i;
const OFFSET_PREFIX = /^\s*(?:0x)?[0-9a-f]+\s*[:|]\s*/i;

/** Dump formats are only tried on lines this short; real xxd and hexdump lines are about 80. */
const MAX_DUMP_LINE = 256;

interface DataLine {
  readonly number: number;
  readonly text: string;
  /** True when the line came from a dump format whose layout we do not mirror. */
  readonly dump: boolean;
}

export function parseHex(input: string): ParsedHex {
  let text = input.replace(/\r\n?/g, "\n");
  let lineOffset = 0;

  const marker = text.indexOf("edid-decode (hex):");
  if (marker !== -1) {
    lineOffset = text.slice(0, marker).split("\n").length;
    text = takeEdidDecodeHex(text.slice(marker).split("\n").slice(1));
  }

  const isCArray = text.includes("{");
  if (isCArray) {
    const open = text.indexOf("{");
    const close = text.lastIndexOf("}");
    if (close < open) throw new EdidParseError("C array has no closing brace");
    lineOffset += text.slice(0, open).split("\n").length - 1;
    text = text.slice(open + 1, close);
  }
  text = blankBlockComments(text);

  const rawLines = text.split("\n");
  const isHexdump = rawLines.some((l) => l.length <= MAX_DUMP_LINE && HEXDUMP_C.test(l));
  const lines: DataLine[] = [];
  rawLines.forEach((raw, i) => {
    // Dump lines first: their ASCII column may contain "#" or "//".
    const short = raw.length <= MAX_DUMP_LINE;
    const hexdump = short ? HEXDUMP_C.exec(raw) : null;
    if (hexdump?.[1] !== undefined) {
      lines.push({ number: i + 1 + lineOffset, text: hexdump[1], dump: true });
      return;
    }
    const xxd = short ? XXD.exec(raw) : null;
    if (xxd?.[1] !== undefined && /^[0-9a-f]{7,8}: [0-9a-f]{4} /i.test(raw)) {
      lines.push({ number: i + 1 + lineOffset, text: xxd[1].replace(/ /g, ""), dump: true });
      return;
    }
    const line = raw.replace(/\/\/.*$|#.*$/, "").trimEnd();
    if (isHexdump && line.trim() === "*") {
      throw new EdidParseError(
        `line ${i + 1 + lineOffset}: hexdump left out repeated lines ("*"); dump again with hexdump -v -C`,
      );
    }
    // hexdump -C ends with a line holding only the final offset.
    if (isHexdump && /^[0-9a-f]{8}$/i.test(line.trim())) return;
    if (line.trim() === "") {
      lines.push({ number: i + 1 + lineOffset, text: "", dump: false });
      return;
    }
    const stripped = line.replace(OFFSET_PREFIX, (m) => (looksLikeOffset(m, line) ? "" : m));
    lines.push({ number: i + 1 + lineOffset, text: stripped, dump: stripped !== line });
  });

  const bytes: number[] = [];
  const perLine: number[] = [];
  let prefixed = 0;
  let unprefixed = 0;
  let upper = 0;
  let lower = 0;
  let commas = false;
  let trailingComma = false;
  let compact = false;
  let dump = false;
  let blankBetweenBlocks = false;
  let blankAtBoundary = false;

  for (const line of lines) {
    if (line.text.trim() === "") {
      if (bytes.length > 0 && bytes.length % 128 === 0) blankAtBoundary = true;
      continue;
    }
    // A blank line counts as a block gap only when more data follows it.
    if (blankAtBoundary) blankBetweenBlocks = true;
    blankAtBoundary = false;
    dump ||= line.dump;
    if (line.text.includes(",")) commas = true;
    if (/,\s*$/.test(line.text)) trailingComma = true;
    let count = 0;
    for (const token of line.text.split(/[\s,;]+/).filter((t) => t !== "")) {
      const body = token.replace(/^0x/i, "");
      if (body.length !== token.length) prefixed++;
      else unprefixed++;
      if (!/^[0-9a-f]+$/i.test(body) || body.length % 2 !== 0) {
        throw new EdidParseError(`line ${line.number}: ${quoteForMessage(token)} is not a hex byte`);
      }
      if (body.length > 2) {
        if (body.length !== token.length) {
          throw new EdidParseError(`line ${line.number}: ${quoteForMessage(token)} is more than one byte`);
        }
        compact = true;
      }
      if (/[A-F]/.test(body)) upper++;
      if (/[a-f]/.test(body)) lower++;
      if (bytes.length + body.length / 2 > MAX_EDID_BYTES) {
        throw new EdidInputError(
          "too-many-bytes",
          `more than ${MAX_EDID_BYTES} bytes of hex; the largest EDID is 256 blocks of 128 bytes`,
        );
      }
      for (let i = 0; i < body.length; i += 2) {
        bytes.push(parseInt(body.slice(i, i + 2), 16));
        count++;
      }
    }
    perLine.push(count);
  }

  if (bytes.length === 0) throw new EdidParseError("no hex bytes found");
  if (prefixed > 0 && unprefixed > 0) {
    throw new EdidParseError("some bytes have a 0x prefix and some do not; check the input is one EDID");
  }

  const first = perLine[0] ?? 0;
  const style: HexStyle = dump
    ? { ...DEFAULT_HEX_STYLE, uppercase: upper > 0 && lower === 0 }
    : {
        uppercase: upper > 0 && lower === 0,
        prefix: prefixed > 0 ? "0x" : "",
        separator: compact ? "" : commas ? ", " : " ",
        bytesPerLine: perLine.length === 1 ? 0 : first,
        trailingSeparator: trailingComma,
        blankLineBetweenBlocks: blankBetweenBlocks,
      };
  return { bytes: Uint8Array.from(bytes), style };
}

/** Replaces each C block comment with spaces, keeping line breaks. Linear time. */
function blankBlockComments(text: string): string {
  let out = "";
  let from = 0;
  for (;;) {
    const open = text.indexOf("/*", from);
    if (open === -1) return out + text.slice(from);
    const close = text.indexOf("*/", open + 2);
    if (close === -1) throw new EdidParseError("a /* comment is never closed");
    out += text.slice(from, open) + text.slice(open, close + 2).replace(/[^\n]/g, " ");
    from = close + 2;
  }
}

/** The hex lines after "edid-decode (hex):", up to the first line that is neither hex nor blank. */
function takeEdidDecodeHex(lines: readonly string[]): string {
  const out: string[] = [];
  for (const line of lines) {
    if (line.trim() !== "" && !/^\s*([0-9a-f]{2}\s+)*[0-9a-f]{2}\s*$/i.test(line)) break;
    out.push(line);
  }
  return out.join("\n");
}

/**
 * An offset prefix is a hex number followed by ":" or "|". Treat it as an
 * offset only when what follows still looks like hex bytes, so a line that
 * merely contains a colon is reported, not mangled.
 */
function looksLikeOffset(prefix: string, line: string): boolean {
  const rest = line.slice(prefix.length);
  return /^([0-9a-f]{2}([\s,]+|$))+/i.test(rest);
}

export function formatHex(bytes: ArrayLike<number>, style: HexStyle = DEFAULT_HEX_STYLE): string {
  const token = (v: number) => {
    const h = v.toString(16).padStart(2, "0");
    return style.prefix + (style.uppercase ? h.toUpperCase() : h);
  };
  const perLine = style.bytesPerLine > 0 ? style.bytesPerLine : bytes.length;
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += perLine) {
    const row: string[] = [];
    for (let j = i; j < Math.min(i + perLine, bytes.length); j++) row.push(token(bytes[j] ?? 0));
    const last = i + perLine >= bytes.length;
    let line = row.join(style.separator);
    if (style.trailingSeparator && !last) line += style.separator.trimEnd();
    lines.push(line);
    if (style.blankLineBetweenBlocks && !last && (i + perLine) % 128 === 0) lines.push("");
  }
  return lines.join("\n") + "\n";
}
