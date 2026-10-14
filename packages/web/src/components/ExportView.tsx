import { useMemo, useState } from "react";
import { downloadFileName, EdidExportError, exportEdid, ONE_LINE_HEX_STYLE } from "@edid-studio/core";
import type { ExportFormat } from "@edid-studio/core";
import { saveFile } from "../download.ts";
import { current } from "../session.ts";
import type { Session } from "../session.ts";

export function ExportView({ session }: { readonly session: Session }) {
  const edid = current(session);
  const mirror = session.source.format === "hex";
  const [format, setFormat] = useState<ExportFormat>("hex");
  const [copied, setCopied] = useState(false);
  const style = mirror ? session.source.hexStyle : ONE_LINE_HEX_STYLE;

  const result = useMemo(() => {
    try {
      return { hex: exportEdid(edid, "hex", style), bin: exportEdid(edid, "binary"), error: null };
    } catch (e) {
      return { hex: "", bin: new Uint8Array(), error: e instanceof EdidExportError ? e.message : "Export failed." };
    }
  }, [edid, style]);
  const fileName = downloadFileName(edid, format);

  return (
    <section aria-labelledby="export-title">
      <div className="eyebrow">Export</div>
      <h2 id="export-title" className="hero">
        Download for the workstation
      </h2>
      <p className="lede">
        Every export is rebuilt by the serializer, checked for length (128 bytes per block) and checksums, and refused
        if either is wrong.
      </p>

      <div className="export-grid mt">
        <div className="card">
          <h2 className="section">Format</h2>
          <div className="choice" role="radiogroup" aria-label="File format">
            <label>
              <input type="radio" name="fmt" checked={format === "hex"} onChange={() => setFormat("hex")} />
              <span>
                <strong>Hex text (.txt)</strong>
                <small>
                  {mirror ? "Same layout as the file you imported." : "One line of lowercase bytes, like the Tessera files."} The NVIDIA
                  Control Panel exports and loads hex text.
                </small>
              </span>
            </label>
            <label>
              <input type="radio" name="fmt" checked={format === "binary"} onChange={() => setFormat("binary")} />
              <span>
                <strong>Binary (.bin)</strong>
                <small>Raw bytes, for EDID emulators and processors that want a binary file.</small>
              </span>
            </label>
          </div>

          {result.error !== null ? (
            <div className="alert" role="alert">
              <p>
                <strong>Export refused.</strong> {result.error}
              </p>
            </div>
          ) : (
            <>
              <div className="alert ok">
                <p>
                  <strong>{result.bin.length} bytes</strong>, {result.bin.length / 128} {result.bin.length === 128 ? "block" : "blocks"}, all checksums correct.
                </p>
              </div>
              <div className="row mt">
                <span className="filename">{fileName}</span>
              </div>
              <div className="row">
                <button
                  className="btn primary"
                  onClick={() => (format === "hex" ? saveFile(fileName, result.hex, "text/plain") : saveFile(fileName, result.bin, "application/octet-stream"))}
                >
                  Download {fileName.endsWith(".txt") ? ".txt" : ".bin"}
                </button>
                <button
                  className="btn"
                  disabled={format !== "hex"}
                  onClick={() => {
                    void navigator.clipboard.writeText(result.hex).then(
                      () => setCopied(true),
                      () => setCopied(false),
                    );
                  }}
                >
                  {copied ? "Copied" : "Copy hex"}
                </button>
              </div>
              <h2 className="section mt">
                Preview
              </h2>
              <pre className="preview" aria-label="Hex preview">
                {result.hex}
              </pre>
            </>
          )}
        </div>

        <div className="card">
          <h2 className="section">Load it on the workstation</h2>
          <ol className="steps">
            <li>Copy the file to the machine with the RTX PRO / Quadro card.</li>
            <li>Open the NVIDIA Control Panel › Workstation › View system topology.</li>
            <li>Click EDID next to the connector, then open the Load tab.</li>
            <li>Browse to the file, tick the connectors to apply it to, and accept the warning.</li>
            <li>Click Load EDID, then reboot (or re-plug the display): the driver caches EDIDs.</li>
            <li>Check the mode, colour format and bit depth in Change resolution before going live.</li>
          </ol>
          <p className="privacy">GeForce cards have no EDID management; use an EDID emulator with the .bin file instead.</p>
        </div>
      </div>
    </section>
  );
}
