import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
export const CORPUS_DIR = join(REPO_ROOT, "tests/corpus");
export const FIXTURES_DIR = join(REPO_ROOT, "tests/fixtures");

export interface CorpusFile {
  readonly name: string;
  readonly data: Uint8Array;
}

/** Real-hardware EDIDs from edid-decode (binary), plus hex test cases. */
export function corpusFiles(): CorpusFile[] {
  const binDir = join(CORPUS_DIR, "edid-decode");
  const bin = readdirSync(binDir)
    .filter((f) => f !== "LICENSE")
    .map((f) => ({ name: `edid-decode/${f}`, data: new Uint8Array(readFileSync(join(binDir, f))) }));
  const text = readdirSync(CORPUS_DIR)
    .filter((f) => f.endsWith(".test"))
    .map((f) => ({ name: f, data: new Uint8Array(readFileSync(join(CORPUS_DIR, f))) }));
  return [...bin, ...text];
}

/** Owner-supplied reference fixtures (SPEC.md, section 14), when present. */
export function fixtureFiles(): CorpusFile[] {
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".txt") || f.endsWith(".bin"))
    .map((f) => ({ name: f, data: new Uint8Array(readFileSync(join(FIXTURES_DIR, f))) }));
}
