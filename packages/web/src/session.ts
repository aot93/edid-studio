import { serializeEdid } from "@edid-studio/core";
import type { Edid, ImportedEdid } from "@edid-studio/core";

export interface HistoryEntry {
  readonly label: string;
  readonly edid: Edid;
}

/** One loaded EDID: where it came from, and every edit since (the first entry is the import). */
export interface Session {
  readonly fileName: string;
  readonly source: ImportedEdid;
  readonly history: readonly HistoryEntry[];
}

export function newSession(fileName: string, source: ImportedEdid): Session {
  return { fileName, source, history: [{ label: "Imported", edid: source.edid }] };
}

export function current(session: Session): Edid {
  const last = session.history[session.history.length - 1];
  if (last === undefined) throw new Error("internal: empty history");
  return last.edid;
}

/**
 * Applies an edit. The result must serialize (which also runs the export
 * guard) before it joins the history, so the UI never holds a model it
 * could not export.
 */
export function applyEdit(session: Session, label: string, edit: (edid: Edid) => Edid): Session {
  const next = edit(current(session));
  serializeEdid(next);
  return { ...session, history: [...session.history, { label, edid: next }] };
}

export function undo(session: Session): Session {
  return session.history.length > 1 ? { ...session, history: session.history.slice(0, -1) } : session;
}
