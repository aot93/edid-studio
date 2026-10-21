// CTA-861 extension, revision 3. Layouts: CTA-861-I section 7; checked
// against edid-decode parse-cta-block.cpp parse_cta_block(), cta_block(),
// cta_svd(), cta_hdmi_block() and cta_hf_scdb().

import { BLOCK_SIZE, byteAt, checkField, isAllZero, reencodes, slice } from "./bytes.ts";
import { DESCRIPTOR_SIZE, parseDescriptor, serializeDescriptor } from "./descriptors.ts";
import { EdidEncodeError } from "./errors.ts";
import type {
  CtaExtension,
  DataBlock,
  Descriptor,
  HdmiForumDsc,
  HdmiForumFeatures,
  HdmiForumVsdb,
  HdmiVsdb,
  Svd,
  VideoCapabilityDataBlock,
} from "./model.ts";

export const CTA_EXTENSION_TAG = 0x02;

/** Data block tag codes (CTA-861-I table 55). */
const TAG_AUDIO = 1;
const TAG_VIDEO = 2;
const TAG_SPEAKER_ALLOCATION = 4;
const TAG_VENDOR = 3;
const TAG_EXTENDED = 7;

/** Extended tag codes (CTA-861-I table 56). */
const EXT_VIDEO_CAPABILITY = 0x00;
const EXT_YCBCR420_VIDEO = 0x0e;
const EXT_YCBCR420_CAPABILITY_MAP = 0x0f;
export const EXT_HF_EEODB = 0x78;
const EXT_HF_SCDB = 0x79;

/** IEEE OUIs, as 24-bit values; stored little-endian in the block. */
export const OUI_HDMI = 0x000c03;
export const OUI_HDMI_FORUM = 0xc45dd8;

/** Maximum payload a data block header can describe (5-bit length). */
const MAX_DATA_BLOCK_LENGTH = 31;

/**
 * Parses a CTA-861 revision 3 extension (bytes 0 to 126). Returns undefined
 * when the block is not revision 3 or its typed form would not re-encode to
 * the same bytes; the caller then keeps it raw.
 */
export function parseCtaExtension(block: readonly number[]): CtaExtension | undefined {
  const b = (i: number) => byteAt(block, i);
  if (b(0) !== CTA_EXTENSION_TAG || b(1) !== 3) return undefined;
  const offset = b(2);
  // Offset 0 means no data blocks and no DTDs; 1-3 are invalid; above 127 is invalid.
  if (offset < 4 || offset > BLOCK_SIZE - 1) return undefined;

  const dataBlocks: DataBlock[] = [];
  let i = 4;
  while (i < offset) {
    const length = b(i) & 0x1f;
    const end = i + 1 + length;
    if (end > offset) return undefined;
    dataBlocks.push(parseDataBlock(slice(block, i, end)));
    i = end;
  }

  // DTDs follow until an all-zero descriptor or the end of the block
  // (edid-decode stops the same way); everything after must be zero padding.
  const descriptors: Descriptor[] = [];
  let d = offset;
  while (d + DESCRIPTOR_SIZE <= BLOCK_SIZE - 1) {
    const bytes = slice(block, d, d + DESCRIPTOR_SIZE);
    if (isAllZero(bytes)) break;
    descriptors.push(parseDescriptor(bytes));
    d += DESCRIPTOR_SIZE;
  }

  const flags = b(3);
  const cta: CtaExtension = {
    kind: "cta",
    revision: 3,
    underscan: (flags & 0x80) !== 0,
    basicAudio: (flags & 0x40) !== 0,
    ycbcr444: (flags & 0x20) !== 0,
    ycbcr422: (flags & 0x10) !== 0,
    nativeDtdCount: flags & 0x0f,
    dataBlocks,
    descriptors,
  };
  return reencodes(cta, serializeCtaExtension, block.slice(0, BLOCK_SIZE - 1)) ? cta : undefined;
}

/** Writes bytes 0 to 126 of a CTA extension; the caller appends the checksum. */
export function serializeCtaExtension(cta: CtaExtension): number[] {
  const collection = cta.dataBlocks.flatMap(serializeDataBlock);
  const out = [
    CTA_EXTENSION_TAG,
    cta.revision,
    4 + collection.length,
    (cta.underscan ? 0x80 : 0) |
      (cta.basicAudio ? 0x40 : 0) |
      (cta.ycbcr444 ? 0x20 : 0) |
      (cta.ycbcr422 ? 0x10 : 0) |
      checkField("native DTD count", cta.nativeDtdCount, 4),
    ...collection,
    ...cta.descriptors.flatMap(serializeDescriptor),
  ];
  if (out.length > BLOCK_SIZE - 1) {
    throw new EdidEncodeError(
      "CTA extension size",
      `CTA extension size ${out.length} bytes exceeds the 127 available before the checksum`,
    );
  }
  while (out.length < BLOCK_SIZE - 1) out.push(0);
  return out;
}

function parseDataBlock(bytes: readonly number[]): DataBlock {
  const typed = parseTypedDataBlock(bytes);
  if (typed && reencodes(typed, serializeDataBlock, bytes)) return typed;
  return { kind: "raw", bytes: [...bytes] };
}

function parseTypedDataBlock(bytes: readonly number[]): DataBlock | undefined {
  const tag = byteAt(bytes, 0) >> 5;
  const payload = bytes.slice(1);

  if (tag === TAG_VIDEO) return { kind: "video", svds: payload.map(decodeSvd) };
  if (tag === TAG_AUDIO && payload.length > 0 && payload.length % 3 === 0) {
    const sads: (readonly [number, number, number])[] = [];
    for (let i = 0; i < payload.length; i += 3) sads.push([byteAt(payload, i), byteAt(payload, i + 1), byteAt(payload, i + 2)]);
    return { kind: "audio", sads };
  }
  if (tag === TAG_SPEAKER_ALLOCATION && payload.length === 3) {
    return { kind: "speakerAllocation", speakers: byteAt(payload, 0) | (byteAt(payload, 1) << 8) | (byteAt(payload, 2) << 16) };
  }

  if (tag === TAG_VENDOR && payload.length >= 3) {
    const oui = byteAt(payload, 0) | (byteAt(payload, 1) << 8) | (byteAt(payload, 2) << 16);
    const body = payload.slice(3);
    if (oui === OUI_HDMI) return parseHdmiVsdb(body);
    if (oui === OUI_HDMI_FORUM) return parseHdmiForumVsdb(body);
    return undefined;
  }

  if (tag === TAG_EXTENDED && payload.length >= 1) {
    const body = payload.slice(1);
    switch (byteAt(payload, 0)) {
      case EXT_VIDEO_CAPABILITY:
        return parseVideoCapability(body);
      case EXT_YCBCR420_VIDEO:
        return { kind: "ycbcr420Video", svds: body.map(decodeSvd) };
      case EXT_YCBCR420_CAPABILITY_MAP:
        return { kind: "ycbcr420CapabilityMap", bitmap: body };
      case EXT_HF_SCDB: {
        // Two reserved bytes, then the HDMI Forum VSDB payload (edid-decode case 0x779).
        const forum = body.length >= 2 ? parseHdmiForumVsdb(body.slice(2)) : undefined;
        return forum ? { ...forum, scdb: [byteAt(body, 0), byteAt(body, 1)] } : undefined;
      }
    }
  }
  return undefined;
}

export function serializeDataBlock(block: DataBlock): number[] {
  switch (block.kind) {
    case "audio":
      if (block.sads.length === 0) throw new EdidEncodeError("audio data block", "an audio data block needs at least one short audio descriptor");
      return withHeader(TAG_AUDIO, block.sads.flatMap((sad) => sad.map((v) => checkField("short audio descriptor byte", v, 8))));
    case "speakerAllocation": {
      const v = checkField("speaker allocation", block.speakers, 24);
      return withHeader(TAG_SPEAKER_ALLOCATION, [v & 0xff, (v >> 8) & 0xff, v >> 16]);
    }
    case "video":
      return withHeader(TAG_VIDEO, block.svds.map(encodeSvd));
    case "ycbcr420Video":
      return withHeader(TAG_EXTENDED, [EXT_YCBCR420_VIDEO, ...block.svds.map(encodeSvd)]);
    case "ycbcr420CapabilityMap":
      return withHeader(TAG_EXTENDED, [
        EXT_YCBCR420_CAPABILITY_MAP,
        ...block.bitmap.map((v) => checkField("4:2:0 capability map byte", v, 8)),
      ]);
    case "videoCapability":
      return withHeader(TAG_EXTENDED, [EXT_VIDEO_CAPABILITY, ...serializeVideoCapability(block)]);
    case "hdmiVsdb":
      return withHeader(TAG_VENDOR, [...ouiBytes(OUI_HDMI), ...serializeHdmiVsdb(block)]);
    case "hdmiForumVsdb":
      return block.scdb
        ? withHeader(TAG_EXTENDED, [EXT_HF_SCDB, ...block.scdb.map((v) => checkField("HDMI Forum SCDB reserved byte", v, 8)), ...serializeHdmiForumVsdb(block)])
        : withHeader(TAG_VENDOR, [...ouiBytes(OUI_HDMI_FORUM), ...serializeHdmiForumVsdb(block)]);
    case "raw": {
      const bytes = block.bytes.map((v) => checkField("data block byte", v, 8));
      if (bytes.length === 0 || (byteAt(bytes, 0) & 0x1f) !== bytes.length - 1) {
        throw new EdidEncodeError(
          "data block length",
          `data block length in header does not match its ${bytes.length} bytes`,
        );
      }
      return bytes;
    }
  }
}

function withHeader(tag: number, payload: number[]): number[] {
  if (payload.length > MAX_DATA_BLOCK_LENGTH) {
    throw new EdidEncodeError(
      "data block length",
      `data block length ${payload.length} exceeds ${MAX_DATA_BLOCK_LENGTH}`,
    );
  }
  return [(tag << 5) | payload.length, ...payload];
}

function ouiBytes(oui: number): number[] {
  return [oui & 0xff, (oui >> 8) & 0xff, (oui >> 16) & 0xff];
}

/**
 * SVD byte to VIC (CTA-861-I section 7.5.1; edid-decode cta_svd()): bytes
 * 129-192 are VICs 1-64 with the native bit; 1-127 and 193-255 are the VIC
 * itself. 0 and 128 are reserved and decode as VIC 0 or 128, which do not
 * re-encode, so the block stays raw.
 */
export function decodeSvd(byte: number): Svd {
  if (byte >= 129 && byte <= 192) return { vic: byte & 0x7f, native: true };
  return { vic: byte, native: false };
}

export function encodeSvd(svd: Svd): number {
  if (svd.native) {
    if (svd.vic < 1 || svd.vic > 64) {
      throw new EdidEncodeError("SVD native flag", `native flag on VIC ${svd.vic}; only VICs 1 to 64 can carry it`);
    }
    return svd.vic | 0x80;
  }
  const vic = checkField("VIC", svd.vic, 8);
  if (vic === 0 || vic === 128) {
    throw new EdidEncodeError("VIC", `VIC ${vic} is reserved`);
  }
  return vic;
}

function parseVideoCapability(body: readonly number[]): VideoCapabilityDataBlock | undefined {
  if (body.length < 1) return undefined;
  const v = byteAt(body, 0);
  return {
    kind: "videoCapability",
    qy: (v & 0x80) !== 0,
    qs: (v & 0x40) !== 0,
    ptBehaviour: (v >> 4) & 0x03,
    itBehaviour: (v >> 2) & 0x03,
    ceBehaviour: v & 0x03,
    extra: body.slice(1),
  };
}

function serializeVideoCapability(b: VideoCapabilityDataBlock): number[] {
  return [
    (b.qy ? 0x80 : 0) |
      (b.qs ? 0x40 : 0) |
      (checkField("S_PT", b.ptBehaviour, 2) << 4) |
      (checkField("S_IT", b.itBehaviour, 2) << 2) |
      checkField("S_CE", b.ceBehaviour, 2),
    ...b.extra.map((v) => checkField("video capability byte", v, 8)),
  ];
}

function parseHdmiVsdb(body: readonly number[]): HdmiVsdb | undefined {
  if (body.length < 2) return undefined;
  const physicalAddress = (byteAt(body, 0) << 8) | byteAt(body, 1);
  const caps = body[2];
  const tmds = body[3];
  return {
    kind: "hdmiVsdb",
    physicalAddress,
    ...(caps === undefined
      ? {}
      : {
          capabilities: {
            supportsAi: (caps & 0x80) !== 0,
            dc48bit: (caps & 0x40) !== 0,
            dc36bit: (caps & 0x20) !== 0,
            dc30bit: (caps & 0x10) !== 0,
            dcY444: (caps & 0x08) !== 0,
            reserved: (caps >> 1) & 0x03,
            dviDual: (caps & 0x01) !== 0,
          },
        }),
    ...(tmds === undefined ? {} : { maxTmdsClock5MHz: tmds }),
    tail: body.slice(4),
  };
}

function serializeHdmiVsdb(b: HdmiVsdb): number[] {
  const pa = checkField("physical address", b.physicalAddress, 16);
  const out = [pa >> 8, pa & 0xff];
  const c = b.capabilities;
  if (c === undefined) {
    if (b.maxTmdsClock5MHz !== undefined || b.tail.length > 0) {
      throw new EdidEncodeError("HDMI VSDB", "HDMI VSDB fields after the physical address need the capability byte");
    }
    return out;
  }
  out.push(
    (c.supportsAi ? 0x80 : 0) |
      (c.dc48bit ? 0x40 : 0) |
      (c.dc36bit ? 0x20 : 0) |
      (c.dc30bit ? 0x10 : 0) |
      (c.dcY444 ? 0x08 : 0) |
      (checkField("HDMI VSDB reserved bits", c.reserved, 2) << 1) |
      (c.dviDual ? 0x01 : 0),
  );
  if (b.maxTmdsClock5MHz === undefined) {
    if (b.tail.length > 0) {
      throw new EdidEncodeError("HDMI VSDB", "HDMI VSDB fields after the capability byte need the max TMDS clock");
    }
    return out;
  }
  out.push(checkField("HDMI VSDB max TMDS clock", b.maxTmdsClock5MHz, 8));
  out.push(...b.tail.map((v) => checkField("HDMI VSDB byte", v, 8)));
  return out;
}

function parseHdmiForumVsdb(body: readonly number[]): HdmiForumVsdb | undefined {
  if (body.length < 4) return undefined;
  const b = (i: number) => byteAt(body, i);
  const f = b(2);
  const g = b(3);
  return {
    kind: "hdmiForumVsdb",
    version: b(0),
    maxTmdsCharRate5MHz: b(1),
    scdcPresent: (f & 0x80) !== 0,
    scdcReadRequest: (f & 0x40) !== 0,
    cableStatus: (f & 0x20) !== 0,
    ccbpci: (f & 0x10) !== 0,
    lte340McscScramble: (f & 0x08) !== 0,
    independentView3d: (f & 0x04) !== 0,
    dualView3d: (f & 0x02) !== 0,
    osdDisparity3d: (f & 0x01) !== 0,
    maxFrlRate: g >> 4,
    uhdVic: (g & 0x08) !== 0,
    dc48bit420: (g & 0x04) !== 0,
    dc36bit420: (g & 0x02) !== 0,
    dc30bit420: (g & 0x01) !== 0,
    ...(body.length >= 5 ? { features21: decodeFeatures21(b(4)) } : {}),
    ...(body.length >= 7 ? { vrr: { min: b(5) & 0x3f, max: ((b(5) & 0xc0) << 2) | b(6) } } : {}),
    ...(body.length >= 10 ? { dsc: decodeDsc(b(7), b(8), b(9)) } : {}),
    tail: body.slice(body.length >= 10 ? 10 : body.length >= 7 ? 7 : body.length >= 5 ? 5 : 4),
  };
}

const bit = (v: number, n: number) => ((v >> n) & 1) === 1;

function decodeFeatures21(v: number): HdmiForumFeatures {
  return {
    fapaEndExtended: bit(v, 7),
    qms: bit(v, 6),
    mDelta: bit(v, 5),
    cinemaVrr: bit(v, 4),
    negativeMvrr: bit(v, 3),
    fva: bit(v, 2),
    allm: bit(v, 1),
    fapaStartLocation: bit(v, 0),
  };
}

function encodeFeatures21(f: HdmiForumFeatures): number {
  return [f.fapaStartLocation, f.allm, f.fva, f.negativeMvrr, f.cinemaVrr, f.mDelta, f.qms, f.fapaEndExtended].reduce((a, on, i) => a | (on ? 1 << i : 0), 0);
}

function decodeDsc(x7: number, x8: number, x9: number): HdmiForumDsc {
  return {
    dsc12a: bit(x7, 7),
    native420: bit(x7, 6),
    qmsTfrMax: bit(x7, 5),
    qmsTfrMin: bit(x7, 4),
    allBpp: bit(x7, 3),
    bpc16: bit(x7, 2),
    bpc12: bit(x7, 1),
    bpc10: bit(x7, 0),
    maxSlices: x8 & 0x0f,
    maxFrlRate: x8 >> 4,
    totalChunkKBytes: x9 & 0x3f,
    reserved: x9 >> 6,
  };
}

function encodeDsc(d: HdmiForumDsc): number[] {
  return [
    [d.bpc10, d.bpc12, d.bpc16, d.allBpp, d.qmsTfrMin, d.qmsTfrMax, d.native420, d.dsc12a].reduce((a, on, i) => a | (on ? 1 << i : 0), 0),
    (checkField("DSC max FRL rate", d.maxFrlRate, 4) << 4) | checkField("DSC max slices", d.maxSlices, 4),
    (checkField("DSC byte 9 reserved bits", d.reserved, 2) << 6) | checkField("DSC total chunk bytes", d.totalChunkKBytes, 6),
  ];
}

function serializeHdmiForumVsdb(b: HdmiForumVsdb): number[] {
  return [
    checkField("HDMI Forum VSDB version", b.version, 8),
    checkField("HDMI Forum VSDB max TMDS character rate", b.maxTmdsCharRate5MHz, 8),
    (b.scdcPresent ? 0x80 : 0) |
      (b.scdcReadRequest ? 0x40 : 0) |
      (b.cableStatus ? 0x20 : 0) |
      (b.ccbpci ? 0x10 : 0) |
      (b.lte340McscScramble ? 0x08 : 0) |
      (b.independentView3d ? 0x04 : 0) |
      (b.dualView3d ? 0x02 : 0) |
      (b.osdDisparity3d ? 0x01 : 0),
    (checkField("max FRL rate", b.maxFrlRate, 4) << 4) |
      (b.uhdVic ? 0x08 : 0) |
      (b.dc48bit420 ? 0x04 : 0) |
      (b.dc36bit420 ? 0x02 : 0) |
      (b.dc30bit420 ? 0x01 : 0),
    ...groups(b),
    ...b.tail.map((v) => checkField("HDMI Forum VSDB byte", v, 8)),
  ];
}

/** Bytes 4 to 9, as far as the groups go. A later group needs the earlier ones. */
function groups(b: HdmiForumVsdb): number[] {
  const out: number[] = [];
  if (!b.features21) {
    if (b.vrr || b.dsc) throw new EdidEncodeError("HDMI Forum VSDB", "VRR or DSC fields need the HDMI 2.1 feature byte before them");
    return out;
  }
  out.push(encodeFeatures21(b.features21));
  if (!b.vrr) {
    if (b.dsc) throw new EdidEncodeError("HDMI Forum VSDB", "DSC fields need the VRR bytes before them");
    return out;
  }
  const max = checkField("VRRmax", b.vrr.max, 10);
  out.push((checkField("VRRmin", b.vrr.min, 6) | ((max >> 8) << 6)) & 0xff, max & 0xff);
  if (b.dsc) out.push(...encodeDsc(b.dsc));
  return out;
}

/**
 * Extension block count from an HDMI Forum EEODB in block 1, if present.
 * When present it overrides base byte 126 (HDMI 2.1, 10.3.6; edid-decode
 * preparse_cta_block()). Works on raw bytes so the length guard can use it.
 */
export function hfEeodbBlockCount(bytes: ArrayLike<number>): number | undefined {
  if (bytes.length < 2 * BLOCK_SIZE) return undefined;
  return eeodbCountInBlock(slice(bytes, BLOCK_SIZE, 2 * BLOCK_SIZE - 1));
}

/** EEODB extension count in one extension block (bytes 0 to 126), if it has one. */
export function eeodbCountInBlock(block: readonly number[]): number | undefined {
  const at = (i: number) => byteAt(block, i);
  if (at(0) !== CTA_EXTENSION_TAG || at(1) < 3) return undefined;
  const offset = Math.min(at(2), BLOCK_SIZE - 1);
  for (let i = 4; i + 2 < offset; i += (at(i) & 0x1f) + 1) {
    const header = at(i);
    if (header >> 5 === TAG_EXTENDED && (header & 0x1f) >= 2 && at(i + 1) === EXT_HF_EEODB) {
      return at(i + 2);
    }
  }
  return undefined;
}
