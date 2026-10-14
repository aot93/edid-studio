import { useRef, useState } from "react";
import { EdidParseError, importEdid, importUpload, MAX_INPUT_BYTES } from "@edid-studio/core";
import type { ImportedEdid } from "@edid-studio/core";
import { SAMPLE_NAME, sampleBytes } from "../sample.ts";

interface Props {
  readonly onLoaded: (imported: ImportedEdid, fileName: string) => void;
  readonly onNew: () => void;
}

/** Only parse errors are shown as-is; their messages escape any input they quote. */
function describeError(e: unknown): string {
  if (e instanceof EdidParseError) return e.message;
  return "This file could not be read as an EDID.";
}

export function OpenView({ onLoaded, onNew }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);

  const load = (f: () => ImportedEdid, name: string) => {
    try {
      setError(null);
      onLoaded(f(), name);
    } catch (e) {
      setError(describeError(e));
    }
  };

  const loadFile = async (file: File) => {
    // Refuse oversized files before reading them into memory.
    if (file.size > MAX_INPUT_BYTES) {
      setError(`This file is ${file.size.toLocaleString()} bytes; the limit is ${MAX_INPUT_BYTES.toLocaleString()}. An EDID is at most 32,768 bytes.`);
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    load(() => importUpload({ name: file.name, bytes }), file.name);
  };

  return (
    <section aria-labelledby="open-title">
      <div className="eyebrow">Open an EDID</div>
      <h2 id="open-title" className="hero">
        Make the GPU pick the mode you meant
      </h2>
      <p className="lede">
        Load an EDID exported from the NVIDIA Control Panel (Workstation › View system topology › EDID › Export), or
        any binary or hex dump. Inspect every block, strip what you do not want, and download a file to load back
        on the workstation.
      </p>

      <div className="open-grid">
        <div
          className={`drop${over ? " over" : ""}`}
          role="button"
          tabIndex={0}
          aria-describedby="drop-help"
          onClick={() => input.current?.click()}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              input.current?.click();
            }
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            const file = e.dataTransfer.files[0];
            if (file) void loadFile(file);
          }}
        >
          <strong>Drop an EDID file here</strong>
          <span>or click to choose one</span>
          <small id="drop-help">.txt .bin .hex .dat .edid .raw .h .c, or no extension · up to 512 KB</small>
          <input
            ref={input}
            type="file"
            hidden
            accept=".txt,.bin,.hex,.dat,.edid,.raw,.h,.c,text/plain,application/octet-stream"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void loadFile(file);
            }}
          />
        </div>

        <div>
          <label htmlFor="paste" className="sr-only">
            Paste hex
          </label>
          <textarea
            id="paste"
            className="paste"
            spellCheck={false}
            maxLength={MAX_INPUT_BYTES}
            placeholder={"Paste hex: 00 ff ff ff ff ff ff 00 …\nAny layout works: spaces, commas, 0x, xxd, hexdump -C, edid-decode output."}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="row">
            <button className="btn primary" disabled={text.trim() === ""} onClick={() => load(() => importEdid(text), "pasted.txt")}>
              Load pasted hex
            </button>
            <button className="btn" onClick={() => load(() => importEdid(sampleBytes()), SAMPLE_NAME)}>
              Try a sample
            </button>
          </div>
        </div>
      </div>

      <p className="or">No EDID to start from?</p>
      <div className="open-actions">
        <button className="btn primary" onClick={onNew}>
          Create a new EDID
        </button>
        <span className="hint">Pick the resolution, refresh, colour format and bit depth; nothing to upload.</span>
      </div>

      {error !== null && (
        <div className="alert" role="alert">
          <p>
            <strong>Not loaded.</strong> {error}
          </p>
        </div>
      )}

      <p className="privacy">
        Everything happens in this browser tab. Files you open are never uploaded, and the page makes no network
        requests.
      </p>
    </section>
  );
}
