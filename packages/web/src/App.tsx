import { useCallback, useEffect, useRef, useState } from "react";
import { EdidEncodeError, EdidExportError } from "@edid-studio/core";
import type { Edid, ImportedEdid } from "@edid-studio/core";
import { ExportView } from "./components/ExportView.tsx";
import { OpenView } from "./components/OpenView.tsx";
import { Workspace } from "./components/Workspace.tsx";
import { applyEdit, newSession, undo } from "./session.ts";
import type { Session } from "./session.ts";
import { applyTheme, loadTheme } from "./theme.ts";
import type { Theme } from "./theme.ts";

type View = "open" | "edit" | "export";

const NEXT_THEME: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [view, setView] = useState<View>("open");
  const [theme, setTheme] = useState<Theme>(loadTheme);
  // Edits are computed from the latest session at call time, so their errors
  // can be reported to the caller straight away.
  const latest = useRef<Session | null>(null);
  useEffect(() => {
    latest.current = session;
  }, [session]);

  useEffect(() => applyTheme(theme), [theme]);

  const onEdit = useCallback((label: string, edit: (edid: Edid) => Edid): string | null => {
    const s = latest.current;
    if (s === null) return "Nothing is loaded.";
    try {
      const next = applyEdit(s, label, edit);
      latest.current = next;
      setSession(next);
      return null;
    } catch (e) {
      if (e instanceof EdidEncodeError || e instanceof EdidExportError || e instanceof RangeError) return e.message;
      return "That edit could not be applied.";
    }
  }, []);

  // Ctrl/Cmd+Z undoes the last edit, except while typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z" && !typing) {
        e.preventDefault();
        setSession((s) => (s ? undo(s) : s));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const loaded = (imported: ImportedEdid, fileName: string) => {
    const s = newSession(fileName, imported);
    latest.current = s;
    setSession(s);
    setView("edit");
  };

  return (
    <div className="wrap">
      <header className="mast">
        <div className="brand">
          <h1>EDID Studio</h1>
          <span className="tag">Build · explain · export</span>
        </div>
        <nav aria-label="Main">
          <button className={`btn${view === "open" ? " on" : ""}`} onClick={() => setView("open")}>
            Open
          </button>
          <button className={`btn${view === "edit" ? " on" : ""}`} disabled={session === null} onClick={() => setView("edit")}>
            Editor
          </button>
          <button className={`btn${view === "export" ? " on" : ""}`} disabled={session === null} onClick={() => setView("export")}>
            Export
          </button>
          <button className="btn" onClick={() => setTheme(NEXT_THEME[theme])} aria-label={`Theme: ${theme}. Change theme`}>
            Theme: {theme}
          </button>
        </nav>
      </header>

      <main>
        {view === "open" || session === null ? (
          <OpenView onLoaded={loaded} />
        ) : (
          <>
            <div className="toolbar">
              <span className="file">{session.fileName}</span>
              <button className="btn" disabled={session.history.length < 2} onClick={() => setSession(undo(session))} title="Ctrl+Z">
                Undo
              </button>
              {view === "edit" ? (
                <button className="btn primary" onClick={() => setView("export")}>
                  Export…
                </button>
              ) : (
                <button className="btn" onClick={() => setView("edit")}>
                  Back to editor
                </button>
              )}
            </div>
            {view === "edit" ? <Workspace session={session} onEdit={onEdit} /> : <ExportView session={session} />}
          </>
        )}
      </main>

      <footer className="foot">
        <span>EDID Studio · runs entirely in your browser; nothing is uploaded</span>
        <span>VIC table and test corpus from edid-decode (MIT)</span>
      </footer>
    </div>
  );
}
