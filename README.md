# EDID Studio

A local-first tool for building, editing, validating and explaining EDIDs, so a
GPU negotiates exactly the mode, colour format and bit depth you intend,
including non-standard resolutions.

A source picks its output from the display's EDID and a bandwidth check on the
link. When the EDID advertises something the link cannot carry, the driver
quietly falls back, usually to 8-bit. EDID Studio says, for every advertised
mode, whether it fits the link at the advertised format and depth, and builds
EDIDs whose timings and colour flags agree with the link from the start.

> **Status:** pre-alpha. M0 to M3 are done, and DisplayID timings came early
> from M6. The web UI can open, inspect, strip down, build from scratch and
> export EDIDs, with a timing engine (exact refresh, CVT, CVT-RB v1 to v3,
> GTF, VIC and DMT lookups, manual porches), an HDMI link budget and a rule
> engine ([`docs/rules.md`](docs/rules.md)) cross-checked against
> `edid-decode` in CI. The `edidtool` CLI decodes, validates, computes
> timings and link budgets, builds, runs recipes, diffs and converts. All
> nine acceptance tests pass.

## Documents

- [`SPEC.md`](SPEC.md): product spec, the source of truth
- [`CLAUDE.md`](CLAUDE.md): working rules for Claude Code
- [`docs/brand.md`](docs/brand.md) and [`design/tokens.css`](design/tokens.css): style guide

## Layout

| Path | Contents |
| --- | --- |
| `packages/edid-core` | Pure TypeScript library: parse, model, serialize, timing, link analysis, validation, operations. Zero runtime dependencies. |
| `packages/edidtool` | Node CLI over the core |
| `packages/web` | Web UI (React and Vite), static and browser-only |
| `tests/fixtures` | Reference EDIDs from the Tessera SX40 case |
| `tests/corpus` | Third-party EDIDs for round-trip and decoder tests |
| `design` | Design tokens shared by the web UI and HTML reports |

## Development

Requires Node 22.18 or later and pnpm 11.

```bash
pnpm install
pnpm test
pnpm lint
pnpm typecheck
pnpm cli -- --help
pnpm cli -- recipe run recipe.json -o out.txt
pnpm dev        # web UI at http://localhost:5173
pnpm build      # static site in packages/web/dist
pnpm e2e        # build, then browser tests (Playwright)
pnpm edid-decode   # build the pinned edid-decode for the cross-check tests
```

## Deploying the web UI

`pnpm build` writes a static site to `packages/web/dist` that any static host
can serve. EDIDs are processed in the visitor's browser and never uploaded.
The page carries a Content Security Policy in a meta tag; hosts that read
`_headers` (Cloudflare Pages, Netlify) also get `frame-ancestors`, `nosniff`
and the other headers from `packages/web/public/_headers`. Elsewhere, set
those headers in the host's configuration.

## Milestones

| Milestone | Scope |
| --- | --- |
| M0 Foundations | Strict TypeScript, fixtures, hex import and export, base and CTA parse and serialize |
| M1 Validation | Tier 1 and 2 rules, rule IDs, `edid-decode` in CI |
| M2 Timing and link | Timing engine, DTD limits, exact-refresh solver, VIC and DMT tables, link analyzer |
| M3 CLI and recipes | All CLI commands, operations, recipe runner |
| M4 Web UI | Library, editor, wizard, timing lab, compare, export |
| M5 Platform I/O | Read-only adapters (the app never writes to a machine) |
| M6 v1.1 formats | DisplayID, HDMI Forum SCDB, HDMI 2.1 rules |
