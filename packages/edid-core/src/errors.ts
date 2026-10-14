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
