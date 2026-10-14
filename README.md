# EDID Studio

A local-first tool for building, editing, validating and explaining EDIDs, so a
GPU negotiates exactly the mode, colour format and bit depth you intend,
including non-standard resolutions.

A source picks its output from the display's EDID and a bandwidth check on the
link. When the EDID advertises something the link cannot carry, the driver
quietly falls back, usually to 8-bit. EDID Studio says, for every advertised
mode, whether it fits the link at the advertised format and depth, and builds
EDIDs whose timings and colour flags agree with the link from the start.

> **Status:** pre-alpha. Milestone M0 (parse, serialize, hex import and
> export, length guard) is in place; M1 (validation) is next.

## Documents

- [`SPEC.md`](SPEC.md): product spec, the source of truth
- [`CLAUDE.md`](CLAUDE.md): working rules for Claude Code
- [`docs/brand.md`](docs/brand.md) and [`design/tokens.css`](design/tokens.css): style guide

## Layout

| Path | Contents |
| --- | --- |
| `packages/edid-core` | Pure TypeScript library: parse, model, serialize, timing, link analysis, validation, operations. Zero runtime dependencies. |
| `packages/edidtool` | Node CLI over the core |
| `tests/fixtures` | Reference EDIDs from the Tessera SX40 case |
| `tests/corpus` | Third-party EDIDs for round-trip and decoder tests |
| `design` | Design tokens shared by the web UI and HTML reports |

The web UI (milestone M4) will be added as `packages/web`.

## Development

Requires Node 22.18 or later and pnpm 11.

```bash
pnpm install
pnpm test
pnpm lint
pnpm typecheck
pnpm cli -- --help
```

## Milestones

| Milestone | Scope |
| --- | --- |
| M0 Foundations | Strict TypeScript, fixtures, hex import and export, base and CTA parse and serialize |
| M1 Validation | Tier 1 and 2 rules, rule IDs, `edid-decode` in CI |
| M2 Timing and link | Timing engine, DTD limits, exact-refresh solver, VIC and DMT tables, link analyzer |
| M3 CLI and recipes | All CLI commands, operations, recipe runner |
| M4 Web UI | Library, editor, wizard, timing lab, compare, export |
| M5 Platform I/O | Read adapters, guarded apply |
| M6 v1.1 formats | DisplayID, HDMI Forum SCDB, HDMI 2.1 rules |
