/**
 * The EDID model: a typed tree that the parser builds and the serializer
 * writes back. Every byte of the source is held somewhere in the tree, so
 * parse then serialize reproduces the input exactly.
 *
 * Fields the tool edits get typed values. Bytes it does not yet edit are kept
 * as raw values next to helpers that decode them. Any descriptor, data block
 * or extension whose typed form would not reproduce its source bytes is kept
 * whole as a `raw` node instead (see `parse.ts`).
 *
 * All nodes are plain, immutable, JSON-serialisable data.
 */

export interface Edid {
  readonly base: BaseBlock;
  /** Extension blocks in file order. Block 1 is `extensions[0]`. */
  readonly extensions: readonly Extension[];
}

/** Two bytes of a standard timing (E-EDID 1.4, section 3.9). 0x01 0x01 is unused. */
export type StandardTimingCode = readonly [number, number];

/** EDID base block, bytes 0 to 127 (VESA E-EDID 1.4, section 3). */
export interface BaseBlock {
  /** Bytes 8-9, big-endian: three 5-bit letters. See `manufacturerId()`. */
  readonly manufacturerCode: number;
  /** Bytes 10-11, little-endian. */
  readonly productCode: number;
  /** Bytes 12-15, little-endian. */
  readonly serialNumber: number;
  /** Byte 16: week of manufacture, or 0xff when byte 17 is a model year. */
  readonly week: number;
  /** Byte 17: year minus 1990. */
  readonly yearOffset: number;
  /** Byte 18. */
  readonly version: number;
  /** Byte 19. */
  readonly revision: number;
  /** Byte 20: video input definition. Layout differs between 1.3 and 1.4. */
  readonly videoInput: number;
  /** Bytes 21-22: horizontal and vertical screen size in cm, or aspect ratio on 1.4. */
  readonly screenSize: readonly [number, number];
  /** Byte 23: (gamma x 100) - 100, or 0xff when gamma is defined elsewhere. */
  readonly gamma: number;
  /** Byte 24: feature support. */
  readonly features: number;
  /** Bytes 25-34: colour characteristics, kept raw. */
  readonly chromaticity: readonly number[];
  /** Bytes 35-37: established timings I and II and the manufacturer's byte. */
  readonly establishedTimings: readonly [number, number, number];
  /** Bytes 38-53: eight standard timings. */
  readonly standardTimings: readonly StandardTimingCode[];
  /** Bytes 54-125: four 18-byte descriptors. */
  readonly descriptors: readonly Descriptor[];
}

export type Descriptor =
  | DetailedTimingDescriptor
  | TextDescriptor
  | RangeLimitsDescriptor
  | DummyDescriptor
  | RawDescriptor;

/**
 * Detailed timing descriptor (E-EDID 1.4, section 3.10.2, table 3.21).
 * Values are as stored. Blanking includes borders; see
 * edid-decode parse-base-block.cpp detailed_timings().
 */
export interface DetailedTimingDescriptor {
  readonly kind: "dtd";
  /** 16 bits, units of 10 kHz. Zero marks a display descriptor, so 1 to 65535. */
  readonly pixelClock10kHz: number;
  /** 12 bits. */
  readonly hActive: number;
  /** 12 bits. */
  readonly hBlank: number;
  /** 12 bits. */
  readonly vActive: number;
  /** 12 bits. */
  readonly vBlank: number;
  /** 10 bits. */
  readonly hFrontPorch: number;
  /** 10 bits. */
  readonly hSync: number;
  /** 6 bits. */
  readonly vFrontPorch: number;
  /** 6 bits. */
  readonly vSync: number;
  /** 12 bits, millimetres. 0 means unspecified. */
  readonly hImageMm: number;
  /** 12 bits, millimetres. 0 means unspecified. */
  readonly vImageMm: number;
  /** 8 bits. */
  readonly hBorder: number;
  /** 8 bits. */
  readonly vBorder: number;
  /** Byte 17: interlace, stereo and sync definition. See `decodeDtdFlags()`. */
  readonly flags: number;
}

/** Display product name (0xfc), serial (0xff) or alphanumeric data string (0xfe). */
export interface TextDescriptor {
  readonly kind: "text";
  readonly tag: TextDescriptorTag;
  /** At most 13 characters, one per byte. */
  readonly text: string;
}

export type TextDescriptorTag = 0xfc | 0xfe | 0xff;

/** Display range limits descriptor, tag 0xfd (E-EDID 1.4, section 3.10.3.3). Values as stored. */
export interface RangeLimitsDescriptor {
  readonly kind: "rangeLimits";
  /** Byte 4: rate offset flags (1.4 only; 0 on 1.3). */
  readonly offsetFlags: number;
  readonly minVerticalHz: number;
  readonly maxVerticalHz: number;
  readonly minHorizontalKHz: number;
  readonly maxHorizontalKHz: number;
  /** Byte 9: maximum pixel clock in units of 10 MHz. */
  readonly maxPixelClock10MHz: number;
  /** Byte 10: video timing support flags (default GTF, range only, secondary GTF, CVT). */
  readonly timingSupport: number;
  /** Bytes 11-17, meaning set by `timingSupport`. */
  readonly timingData: readonly number[];
}

/** Dummy descriptor, tag 0x10, all other bytes zero. */
export interface DummyDescriptor {
  readonly kind: "dummy";
}

/** Any other 18-byte descriptor, kept byte for byte. */
export interface RawDescriptor {
  readonly kind: "raw";
  readonly bytes: readonly number[];
}

export type Extension = CtaExtension | RawExtension;

/** Any extension block the model does not type, bytes 0 to 126; the checksum is recomputed. */
export interface RawExtension {
  readonly kind: "raw";
  readonly bytes: readonly number[];
}

/** CTA-861 extension, revision 3 (CTA-861-I, section 7.3; edid-decode parse_cta_block()). */
export interface CtaExtension {
  readonly kind: "cta";
  /** Byte 1. Only revision 3 is typed; others stay raw. */
  readonly revision: 3;
  /** Byte 3 bit 7. */
  readonly underscan: boolean;
  /** Byte 3 bit 6. */
  readonly basicAudio: boolean;
  /** Byte 3 bit 5. */
  readonly ycbcr444: boolean;
  /** Byte 3 bit 4. */
  readonly ycbcr422: boolean;
  /** Byte 3 bits 3-0. */
  readonly nativeDtdCount: number;
  readonly dataBlocks: readonly DataBlock[];
  /** 18-byte descriptors after the data block collection, before zero padding. */
  readonly descriptors: readonly Descriptor[];
}

export type DataBlock =
  | VideoDataBlock
  | Ycbcr420VideoDataBlock
  | Ycbcr420CapabilityMapDataBlock
  | VideoCapabilityDataBlock
  | HdmiVsdb
  | HdmiForumVsdb
  | RawDataBlock;

/** Short video descriptor. `native` is only expressible for VICs 1 to 64. */
export interface Svd {
  readonly vic: number;
  readonly native: boolean;
}

/** Video data block, tag 2. */
export interface VideoDataBlock {
  readonly kind: "video";
  readonly svds: readonly Svd[];
}

/** YCbCr 4:2:0 video data block, extended tag 0x0e. */
export interface Ycbcr420VideoDataBlock {
  readonly kind: "ycbcr420Video";
  readonly svds: readonly Svd[];
}

/**
 * YCbCr 4:2:0 capability map, extended tag 0x0f. Bit i (LSB first within
 * each byte) refers to the i-th SVD. An empty map means every SVD.
 */
export interface Ycbcr420CapabilityMapDataBlock {
  readonly kind: "ycbcr420CapabilityMap";
  readonly bitmap: readonly number[];
}

/** Video capability data block, extended tag 0x00. */
export interface VideoCapabilityDataBlock {
  readonly kind: "videoCapability";
  /** QY: selectable YCC quantisation range. */
  readonly qy: boolean;
  /** QS: selectable RGB quantisation range. */
  readonly qs: boolean;
  /** S_PT, 2 bits. */
  readonly ptBehaviour: number;
  /** S_IT, 2 bits. */
  readonly itBehaviour: number;
  /** S_CE, 2 bits. */
  readonly ceBehaviour: number;
  /** Bytes after the first payload byte, if any. */
  readonly extra: readonly number[];
}

/** HDMI 1.4 VSDB, OUI 00-0C-03 (stored 03 0C 00). edid-decode cta_hdmi_block(). */
export interface HdmiVsdb {
  readonly kind: "hdmiVsdb";
  /** Source physical address A.B.C.D as a 16-bit value, 0xABCD. */
  readonly physicalAddress: number;
  /** The byte after the physical address. Absent when the block ends before it. */
  readonly capabilities?: HdmiVsdbCapabilities;
  /** Max TMDS clock, the next byte, in units of 5 MHz. Absent when the block ends before it. */
  readonly maxTmdsClock5MHz?: number;
  /** Remaining bytes: latency, content types, HDMI VICs and 3D, kept raw. */
  readonly tail: readonly number[];
}

export interface HdmiVsdbCapabilities {
  readonly supportsAi: boolean;
  readonly dc48bit: boolean;
  readonly dc36bit: boolean;
  readonly dc30bit: boolean;
  readonly dcY444: boolean;
  /** Bits 2-1, reserved. */
  readonly reserved: number;
  readonly dviDual: boolean;
}

/** HDMI Forum VSDB, OUI C4-5D-D8 (stored D8 5D C4). edid-decode cta_hf_scdb(). */
export interface HdmiForumVsdb {
  readonly kind: "hdmiForumVsdb";
  readonly version: number;
  /** Units of 5 MHz; 0 means no rate above 340 MHz. */
  readonly maxTmdsCharRate5MHz: number;
  readonly scdcPresent: boolean;
  readonly scdcReadRequest: boolean;
  readonly cableStatus: boolean;
  readonly ccbpci: boolean;
  readonly lte340McscScramble: boolean;
  readonly independentView3d: boolean;
  readonly dualView3d: boolean;
  readonly osdDisparity3d: boolean;
  /** 4 bits. */
  readonly maxFrlRate: number;
  readonly uhdVic: boolean;
  readonly dc48bit420: boolean;
  readonly dc36bit420: boolean;
  readonly dc30bit420: boolean;
  /** Payload bytes after the fixed fields (VRR, DSC and so on), kept raw. */
  readonly tail: readonly number[];
}

/** Any other data block, header byte included, kept byte for byte. */
export interface RawDataBlock {
  readonly kind: "raw";
  readonly bytes: readonly number[];
}
