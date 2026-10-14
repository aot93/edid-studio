/** Input could not be read as an EDID. Nothing was produced. */
export class EdidParseError extends Error {
  override name = "EdidParseError";
}

/** A model value does not fit its EDID field. `field` names the field in plain language. */
export class EdidEncodeError extends Error {
  override name = "EdidEncodeError";
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.field = field;
  }
}

/** Bytes failed the export guard (length or checksum). Nothing was written. */
export class EdidExportError extends Error {
  override name = "EdidExportError";
}

export type InputRejection =
  | "too-large"
  | "too-many-bytes"
  | "not-text"
  | "known-file-type"
  | "bad-file-name"
  | "unsupported-extension";

/**
 * Input refused before parsing: too large, the wrong kind of file, or a bad
 * file name. `reason` is stable, for UI messages and tests.
 */
export class EdidInputError extends EdidParseError {
  override name = "EdidInputError";
  readonly reason: InputRejection;
  constructor(reason: InputRejection, message: string) {
    super(message);
    this.reason = reason;
  }
}
