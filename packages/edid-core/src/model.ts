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

export type Extension = CtaExtension | DisplayIdExtension | RawExtension;

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
  | AudioDataBlock
  | SpeakerAllocationDataBlock
  | VideoDataBlock
  | Ycbcr420VideoDataBlock
  | Ycbcr420CapabilityMapDataBlock
  | VideoCapabilityDataBlock
  | HdmiVsdb
  | HdmiForumVsdb
  | RawDataBlock;

/**
 * Audio data block, tag 1: short audio descriptors, three bytes each
 * (CTA-861-I section 7.5.2; edid-decode cta_audio_block()). Byte 0: format
 * code in bits 6-3, channels - 1 in bits 2-0. Byte 1: sample rates, bit 0
 * 32 kHz up to bit 6 192 kHz. Byte 2: for LPCM, sample sizes 16/20/24 in
 * bits 0-2; for other formats, their own meaning. Kept as stored.
 */
export interface AudioDataBlock {
  readonly kind: "audio";
  readonly sads: readonly (readonly [number, number, number])[];
}

/**
 * Speaker allocation data block, tag 4: a 24-bit speaker mask, little-endian
 * (CTA-861-I section 7.5.3; edid-decode cta_sadb(), bit 0 FL/FR, 1 LFE1,
 * 2 FC, 3 LS/RS, 4 BC, 5 FLc/FRc, 6 BL/BR, ...).
 */
export interface SpeakerAllocationDataBlock {
  readonly kind: "speakerAllocation";
  readonly speakers: number;
}

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

/**
 * HDMI Forum VSDB, OUI C4-5D-D8 (stored D8 5D C4), or the same fields as an
 * HDMI Forum SCDB, extended tag 0x79 (HDMI 2.1 section 10.3.2; edid-decode
 * cta_hf_scdb() and case 0x779). Payload bytes, counting from the version:
 * 0 version, 1 max TMDS, 2 SCDC and 3D flags, 3 max FRL rate and 4:2:0 deep
 * colour, 4 HDMI 2.1 features, 5-6 VRR range, 7-9 DSC. A group is typed only
 * when the block holds all of its bytes; anything after is kept in `tail`.
 */
export interface HdmiForumVsdb {
  readonly kind: "hdmiForumVsdb";
  /** Present for the SCDB form: its two reserved bytes, as stored. Absent for the VSDB. */
  readonly scdb?: readonly [number, number];
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
  /** 4 bits: 0 none, 1 3x3, 2 6x3, 3 6x4, 4 8x4, 5 10x4, 6 12x4 (lanes x Gbps). See FRL_RATES. */
  readonly maxFrlRate: number;
  readonly uhdVic: boolean;
  readonly dc48bit420: boolean;
  readonly dc36bit420: boolean;
  readonly dc30bit420: boolean;
  /** Byte 4. Absent when the block ends before it. */
  readonly features21?: HdmiForumFeatures;
  /** Bytes 5-6. Absent when the block ends before them. */
  readonly vrr?: { readonly min: number; readonly max: number };
  /** Bytes 7-9. Absent when the block ends before them. */
  readonly dsc?: HdmiForumDsc;
  /** Payload bytes after the typed groups, kept raw. */
  readonly tail: readonly number[];
}

/** HDMI Forum byte 4, bit 7 first. */
export interface HdmiForumFeatures {
  readonly fapaEndExtended: boolean;
  readonly qms: boolean;
  readonly mDelta: boolean;
  /** CinemaVRR, deprecated: edid-decode warns when set. */
  readonly cinemaVrr: boolean;
  readonly negativeMvrr: boolean;
  /** Fast Vactive. */
  readonly fva: boolean;
  /** Auto Low-Latency Mode. */
  readonly allm: boolean;
  readonly fapaStartLocation: boolean;
}

/** HDMI Forum bytes 7-9: VESA DSC 1.2a support. */
export interface HdmiForumDsc {
  readonly dsc12a: boolean;
  /** Compressed video transport for 4:2:0. */
  readonly native420: boolean;
  readonly qmsTfrMax: boolean;
  readonly qmsTfrMin: boolean;
  /** Any valid 1/16th-bit bpp. */
  readonly allBpp: boolean;
  readonly bpc16: boolean;
  readonly bpc12: boolean;
  readonly bpc10: boolean;
  /** 4 bits: 0 none, 1-7 slice and clock limits (edid-decode dsc_max_slices). */
  readonly maxSlices: number;
  /** 4 bits, coded as maxFrlRate. */
  readonly maxFrlRate: number;
  /** 6 bits: total bytes in a line of chunks is 1024 x (1 + this). */
  readonly totalChunkKBytes: number;
  /** Byte 9 bits 7-6, reserved. */
  readonly reserved: number;
}

/** Any other data block, header byte included, kept byte for byte. */
export interface RawDataBlock {
  readonly kind: "raw";
  readonly bytes: readonly number[];
}

/**
 * DisplayID section in an EDID extension block, tag 0x70 (DisplayID 1.3
 * section 2; edid-decode parse_displayid_block(), Linux drm_displayid.c).
 * Byte 0 is the tag, bytes 1-4 the section header, data blocks from byte 5,
 * then the section checksum and zero padding to byte 126.
 */
export interface DisplayIdExtension {
  readonly kind: "displayid";
  /** Byte 1: structure version, 0x12 for DisplayID 1.2. */
  readonly version: number;
  /** Byte 3: product type (1.x) or primary use case (2.x); 0 in an extension section. */
  readonly productType: number;
  /** Byte 4: DisplayID extension sections that follow. */
  readonly extensionCount: number;
  readonly dataBlocks: readonly DisplayIdDataBlock[];
  /** Zero bytes inside the section after the data blocks; many real sections fill all 121. */
  readonly filler: number;
}

export type DisplayIdDataBlock = DisplayIdType1TimingBlock | RawDisplayIdDataBlock;

/** Video Timing Modes Type 1, Detailed Timings Data Block, tag 0x03: 20 bytes per timing. */
export interface DisplayIdType1TimingBlock {
  readonly kind: "type1Timings";
  /** Byte 1 of the block header: revision in bits 2-0, the rest reserved. */
  readonly revision: number;
  readonly timings: readonly DisplayIdTiming[];
}

/**
 * One Type I detailed timing. Values are the real counts; each is stored
 * minus one (edid-decode parse_displayid_type_1_7_timing(), drm
 * drm_mode_displayid_detailed()). Blanking is the whole blanking interval.
 */
export interface DisplayIdTiming {
  /** 24 bits stored, units of 10 kHz, so 1 to 16777216. */
  readonly pixelClock10kHz: number;
  /** Byte 3: preferred (bit 7), 3D stereo (6-5), interlaced (4), aspect ratio code (3-0). */
  readonly flags: number;
  /** 16 bits stored: 1 to 65536. */
  readonly hActive: number;
  readonly hBlank: number;
  /** 15 bits stored: 1 to 32768. */
  readonly hFrontPorch: number;
  readonly hSync: number;
  readonly hSyncPositive: boolean;
  readonly vActive: number;
  readonly vBlank: number;
  readonly vFrontPorch: number;
  readonly vSync: number;
  readonly vSyncPositive: boolean;
}

/** Any other DisplayID data block, 3-byte header included, kept byte for byte. */
export interface RawDisplayIdDataBlock {
  readonly kind: "raw";
  readonly bytes: readonly number[];
}
