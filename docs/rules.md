# Validation rules

Generated from `packages/edid-core/src/validate.ts` by `pnpm rules-doc`; do not edit by hand.
Errors block export. Warnings and notes do not. Severities follow `edid-decode` (fail is error,
warn is warning), except where a hardware-verified EDID shows a source accepts it anyway.

## Tier 1: structure

| ID | Severity | Rule |
| --- | --- | --- |
| `structure.length` | error | Length is 128 x (1 + extension count) |
| `structure.header` | error | Block 0 starts with the EDID header |
| `structure.checksum` | error | Every block sums to zero |
| `cta.revision` | warning | CTA-861 extension is revision 3 |
| `cta.offset` | error | CTA DTD offset matches the data block collection |
| `cta.padding` | error | CTA padding after the DTDs is zero |
| `structure.block-map` | error | EDID 1.3 with more than two blocks has a block map or an HDMI Forum EEODB |
| `displayid.section` | error | DisplayID sections are well formed |
| `descriptor.header` | error | Display descriptor bytes 2 and 4 are zero |
| `descriptor.tag` | error | Display descriptor tag is defined |
| `descriptor.all-zero` | warning | Unused descriptors are dummy descriptors |
| `descriptor.dummy-garbage` | error | Dummy descriptors are all zero after the tag |
| `text.printable` | error | Text descriptors hold printable ASCII |
| `text.layout` | warning | Text ends with 0x0a and is padded with spaces |

## Tier 2: semantics

| ID | Severity | Rule |
| --- | --- | --- |
| `base.preferred-timing` | error | The first descriptor is the preferred detailed timing |
| `base.depth-on-1.3` | error | Bit depth is only set on EDID 1.4 |
| `base.depth-reserved` | error | EDID 1.4 bit depth is not the reserved value |
| `base.srgb` | warning | sRGB chromaticity and the sRGB flag agree |
| `base.range-limits-missing` | error | EDID 1.3 has a range limits descriptor |
| `base.name-missing` | warning | A monitor name is present |
| `range.order` | error | Range minimums do not exceed maximums |
| `range.class` | warning | Range limit class is allowed for the EDID version |
| `range.covers-timings` | warning | Range limits cover every timing |
| `std.unused-code` | error | Unused standard timings are 01 01 |
| `svd.unknown-vic` | error | Every SVD is a known VIC |
| `svd.duplicate` | error | No VIC is listed twice |
| `y420.map-length` | error | 4:2:0 capability map has no more bits than SVDs |
| `cta.byte3-consistent` | error | Byte 3 is the same in every CTA extension |
| `cta.640x480` | info | 640x480 @ 60 Hz is listed (CTA-861) |
| `hdmi.edid-version` | warning | HDMI sinks use EDID 1.3 |
| `hdmi.vsdb-structure` | error | HDMI VSDB length covers every field it sets |
| `hdmi.vsdb-tmds` | error | HDMI VSDB max TMDS clock is at most 340 MHz |
| `hdmi.max-tmds` | error | Max TMDS covers the fastest mode |
| `hdmi.vic-equivalents` | error | HDMI VICs have their CTA-861 VICs in the video data block |
| `hdmi.forum-vsdb-needed` | error | Modes above 340 MHz have an HDMI Forum VSDB with SCDC |
| `color.y444-flag` | error | DC_Y444 needs YCbCr 4:4:4 support |
| `color.y444-depth` | warning | DC_Y444 needs a deep colour depth |
| `color.420-depth` | warning | 4:2:0 deep colour needs 4:2:0 modes |
| `color.subsampled-odd` | error | YCbCr 4:2:2 is not declared with an odd-width timing |

## Tier 3: link feasibility

| ID | Severity | Rule |
| --- | --- | --- |
| `link.too-fast` | warning | Advertised depths fit the link at every mode |
| `link.depth-unusable` | warning | Every advertised depth is usable at some mode |
