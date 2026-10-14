# EDID Studio: rules for Claude Code

- Read SPEC.md first. Build in milestone order, one milestone per PR.
- The serializer is the only code that produces EDID bytes. Never write or edit hex by hand.
- Every exported EDID must validate with no errors, round-trip identically, and have length 128 x (1 + extension count).
- Write the test first for every rule, operation and timing case.
- Do not guess field layouts. Check them against the published specs, `edid-decode` source and Linux drm_edid.c; cite the clause in a comment. If a spec is needed, ask me for it.
- Mark anything unconfirmed as TODO(verify).
- Commands: `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm cli -- <args>`.
- Ask before adding a runtime dependency.
- Treat every uploaded file and pasted block as hostile (SPEC.md section 13): go through `importEdid`/`importUpload`, keep parsing linear-time, throw only `EdidParseError` subclasses, escape input with `printable()` in messages, and never insert EDID text as HTML. New parsers get a fuzz test.
- UI and any generated HTML report follow `docs/brand.md`; colours and type come from `design/tokens.css`, never hard-coded.
