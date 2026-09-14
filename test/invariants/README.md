# `test/invariants/` — guards that read the source

These tests do not run the code; they read it. Each one pins a rule that the type checker and the
linter cannot express on their own: a vocabulary that must be declared once, a module that must be
the only owner of something, a table that must still describe the tree, a ratchet whose number may
only go down.

**The boundary.** A file belongs here when it scans `src/**` and imports nothing from it. One that
*also* drives the module it scans stays in `test/unit` — moving it would separate the assertion from
the behaviour it depends on. Three files were moved back for exactly that reason
(`swarm-registries`, `peer-frame-vocabulary`, `xdg-integration`).

**Two traps, both hit while this folder was created.**

A guard that looks for a sibling unit test must name `test/unit` explicitly. The three
`*-module-boundaries` guards scanned `readdirSync(here)`; once they moved, `here` was this folder and
the scan would have passed while nothing drove anything.

A guard that reads `git ls-files` sees the index, not the working tree. An unstaged deletion still
lists, and the guard then opens a file that is gone.

Run with `npm run test:unit` (unit + invariants) or `npm run test:node:core` (adds `test/raw`).
Curated, not an index: `ls test/invariants` is the index.
