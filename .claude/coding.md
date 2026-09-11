# Mirall — Coding Standard

> Any future code changes, reviews, or automated agent runs in this repository must read this file
> first and follow it. If a change conflicts with a rule here, either follow the rule or update the
> rule deliberately in the same change — never silently ignore it.

This is the binding style and architecture guide for `mirall-app`. It states the standards this
codebase actually holds itself to: what to name things, where code goes, how big a unit may get,
what a comment is for, which shapes are banned, and which existing patterns to copy. Check new code
against it before calling the work done. It is written to stand alone — you should not need any
other document to write code that fits here. For deeper reference: `.claude/solution-architecture.md`
(what the system is), `.claude/testing.md` (test layers and the a11y bar), `.claude/lessons.md`
(hard-won debugging specifics).

---

## 1. The shape of the system

Three runtimes, one shared vocabulary. Know which one you are in before you write a line.


| Runtime           | Path                           | Module system               | Can import                                                                                       |
| ----------------- | ------------------------------ | --------------------------- | ------------------------------------------------------------------------------------------------ |
| **Electron main** | `src/main/`, `src/preload/`    | CommonJS                    | Node, Electron, `src/shared/contract/**`                                                         |
| **Renderer**      | `src/renderer/`                | ESM, React 19 + Tailwind v4 | browser APIs, `window.bridge`, and `src/shared/contract/` — **nothing else under `src/shared/`** |
| **Bare worker**   | `src/worker/`, `src/shared/**` | ESM                         | `bare-*`, Hyper stack, Node-ish                                                                  |


`src/shared/contract/` is the one package all three read. It imports nothing — not even a sibling
outside itself — so esbuild can bundle it into the renderer, Bare can load it in the worker, and
main can `require` it. **Never add an import to a `contract/` module.**

Hard boundaries, each enforced by a gate rather than a comment:

- The renderer imports `src/shared/contract/**` only (`no-restricted-imports` +
`test/unit/renderer-contract-only-imports.test.js`). Need data-layer logic in the UI? Move the
rule into `contract/`, or ask the worker over IPC. Do not copy it.
- A module that a `test/unit` test loads under plain Node must not import `bare-*`. The pure half of
`folders/` is listed in `eslint.config.mjs` → `pureFolderPolicyModules` and enforced there; do the
I/O in the engine that calls the policy.
- Vendored code (`src/shared/transfer/backends/overlay/vendor/`) stays re-diffable against upstream.
Do not restyle it, do not apply our lint rules to it, and record every local divergence in its
`PROVENANCE.md`.

---

## 2. Naming

**Files**

- `kebab-case.js` for modules — everywhere (`shared/`, `worker/`, `main/`, `store/`).
- `PascalCase.tsx` for React components. Nothing non-PascalCase inside `components/*` except a
co-located `types.ts`.
- `use*.ts` for hooks. `.tsx` only if the file also houses a Provider.
- Test files: `test/<layer>/<subject>.test.js`. Frontend scenarios: `test/frontend/scenarios/sNN-<slug>.mjs`.

**Components** — the suffix is a contract, not decoration:


| Suffix      | Means                              |
| ----------- | ---------------------------------- |
| `*Card`     | a tinted surface tile              |
| `*Row`      | one entry in a list                |
| `*Lane`     | a sub-region of a row              |
| `*Screen`   | mounted directly by `ScreenRouter` |
| `*Settings` | a page under the settings hub      |
| `*Section`  | a piece of a page                  |


Props types are `XxxProps`, never a bare `Props`. Use `TFunction` from i18next, never a hand-typed `t`.

**Functions and variables** — `camelCase`; `SCREAMING_SNAKE` for frozen vocabulary and tuning
constants. Booleans read as predicates (`isMountFault`, `hasRoutableAddress`). A function that
returns a decision is named for the decision (`supersedeDecision`, `stallVerdict`,
`routableAddressKind`), not for its mechanics.

**One word, one concept.** Word collisions across the data layer are the single biggest navigation
tax here, because they make `grep` lie. Respect these splits:

- *presence* = peer liveness (`state/presence.js`, `transfer/presence-broadcast.js`). File-on-disk
presence is *retire-confirm* / *disk-presence*.
- *admission* = membership gating. The download engine's slot gating is a *fetch gate*.
- *diagnostics*: `transfer/diagnostics.js` = support bundle; `swarm-diagnostics.js` = live status;
`core/diagnostics-redact.js` = redaction.
- *health*: `core/health.js` = event-loop lag; `Subsystem.health()` = readiness.
- Error codes are `CODES` (from `contract/errors.js`). The `ErrorCodes` alias is gone — do not
reintroduce a second name for one object.

Before adding a name, grep it. If it already means something else in another domain, pick a
different word — do not disambiguate with a comment.

---

## 3. File and module organisation

**The organising principle: the runtime split stays; inside a runtime, folders are domains; inside a
domain, one file per cohesive unit that shares consumers and purity.**

- Put new data-layer code in its domain folder (`spaces/`, `shares/`, `folders/`, `audit/`,
`storage/`, `transfer/`), not in a technical-layer bucket.
- New IPC handlers follow the `ipc/space-leave.js` precedent: a `registerX(ipc, deps)` module under
`src/worker/ipc/`. Do not grow `worker/main.js`.
- New main-process concerns are their own module exposing `register(deps)`. Do not grow `main/main.js`.
- A screen that needs derivation gets a pure, Node-testable module (`folderStrips.js`,
`folderStatus.js`, `mirrorStateLabel.js` are the pattern) and stays a renderer of that result.

**When to split a file:** it has more than one reason to change, or a reviewer cannot state its job
in one sentence. Files over ~600 lines are a standing smell; the six that exceed it today
(`worker/main.js`, `main/main.js`, `transfer/swarm.js`, `folders/foreign-folders.js`,
`spaces/space.js`, `overlay-backend.js`) are known debt — do not add responsibilities to them.

**When *not* to split:** a one-line re-export "for the import path". Those shims are all deleted;
importers name the real module. Adding a file that only re-exports another is a regression.

**Two legitimate reasons a tiny file exists** — respect both, and say which one applies:

1. It is pure so `test/unit` can drive it under plain Node without a Corestore.
2. It is a cohesive unit with its own consumers.

Merging a pure module into an impure sibling pushes its tests into the slower Bare suite. That is a
real cost; do not do it casually.

**Sidecars.** A `.js` module consumed by the renderer carries a hand-written `.d.ts` next to it.
`tsconfig.json` sets `allowJs`, so the typechecker reaches those modules through the sidecar rather
than by inferring from the JS — which is why the sidecar, not the implementation, is what the
renderer is typed against. Keep the pair in step: a declared export with no runtime backing hands the renderer confident types
over nothing (`test/unit/contract-declarations.test.js` pins this for `contract/`). Delete a `.d.ts`
the moment its module stops being reachable from `src/renderer`.

---

## 4. Function and class design

- **One responsibility per function.** If you need "and" to describe it, split it.
- **Guardrails (enforced as warnings by `complexityBudget` in `eslint.config.mjs`):** cyclomatic
complexity ≤ 20, nesting depth ≤ 4, ≤ 150 lines per function. These are a ceiling on *new* code,
not a target — the warnings that exist today are pre-existing hotspots. Do not add a new warning;
the CI ceiling (`lint:ci --max-warnings`) is a ratchet that only moves down.
- **Prefer returning a decision to performing one.** A pure `xDecision(state) → verdict` that an
impure caller acts on is testable at the unit layer; a function that decides *and* writes is not.
- **Parameters:** past three, take an options object. Never take a parameter you do not read — an
unused `_db`-style placeholder is dead weight that every caller has to keep passing.
- **Introduce a type when the shape crosses a boundary** (IPC payload, persisted record, component
props). Inside one module, a local object literal is fine. Do not wrap a primitive in a class for
its own sake.
- `**any` and `unknown` are banned** in renderer TypeScript. If the type is genuinely open, model it
— a union, a discriminated record, or a declared contract type.
- **Shared logic gets extracted once, into the layer both callers can reach.** If two runtimes need
it, it belongs in `contract/`. Copying a rule into a second runtime is the origin of every
vocabulary drift this codebase has had.

**Lifecycle rules (non-negotiable — the data layer is built on them):**

- Every periodic or deferred job is owned by a `Subsystem` and armed through `this.timers`, inside
`_open()`. **A timer armed at module level runs at import, where no `close()` can ever reach it**
— banned by `moduleLevelTimerRestrictions` and pinned by `test/unit/module-level-timers.test.js`.
- A timer handle that outlives the call that armed it (`announceTimer`, `presenceBeat`) must be
owned by `this.timers` or a module's own `createTimers()` that its `reset` closes.
- A module-level flag that nothing clears is a shutdown latch bug. State that survives a stop must
live on a subsystem that the stop reaches.
- Order two non-atomic writes so that a crash leaves the *visible* failure, not the silent one. Never
swallow the second half with an empty `catch {}`.

---

## 5. Commenting standard

The house style is long-form *why* prose, and it earns its place. The failure mode here has never
been "what" comments — it is **bug archaeology**: explaining what the code used to do and which  
incident changed it, instead of the rule the code now enforces. But the best comment is a comment not written because the code is self explainatory.

**Rules**

1. **State the rule the code enforces, in the present tense.** Name the mechanism. No history.
2. **No "used to", "previously", "the hand-rolled version", "before this fix", "slipped past".** If
 the story matters, its home is a `REGRESSION (…)` test name, the commit message, or
 `.claude/lessons.md` — all three survive; a comment rots.
3. **No internal ids in `src/`** — no `FIX-n`, `MIR-n`, `LIFECYCLE-n`. A contributor cannot resolve
 them from this repository. Blocked by `scripts/check-comment-hygiene.sh`.
4. **No references a reader cannot follow from the repo** — no `.claude/` or plan-doc paths, no `§`
 section cites, no `#123` issue numbers in comments. The one permitted pointer target is
 `.claude/solution-architecture.md`. (`vendor/` is exempt: its tags are defined in `PROVENANCE.md`.)
5. **No commented-out code.** There is none in `src/` today. Keep it that way; git remembers.
6. **No dated or personal TODOs.** Use the issue tracker.
7. **State an invariant once.** If a rule applies at three sites, write it at the canonical site and
 have the others point there ("Scroll-pane rules: see SpaceView's pane."). Three copies drift.
8. **Do not restate the code.** `// Send handshake to all connected peers` above a loop that does
 exactly that is noise.
9. **Numbers in comments rot.** Prefer "every handler" to "all 85 handlers". If you must give a
 count, a test should assert it.

**When a comment IS warranted:** a non-obvious business rule; a correctness-critical ordering; an
algorithm whose shape isn't self-evident; a public API/prop contract; a deliberate asymmetry that
reads as a bug; a named constant whose value was chosen for a reason; a test seam.

**Before / after** — real shapes from this codebase:

```js
// BAD — archaeology, an unresolvable id, and a measurement that will rot
// FIX-BW10 — charge the LEDGER too, not just the bucket. This path used to debit nothing,
// though it was originally documented that way. The arithmetic never worked: 32 KB/s × 30 s
// = 983,040 bytes, and the old implementation resolved void. Measured on a 1 MB/s cap...

// GOOD — the rule, the mechanism, present tense
// An uncontended take is charged to the taker as well as the bucket: without the ledger debit a
// small-chunk stream is starved to 0% under a shared cap.
```

```js
// BAD — restates the code
// Loose files are served in place via the overlay
looseShareFile(...)

// GOOD — or nothing at all
```

**Test seams** are marked, so ~40 test-only exports stop reading as public API: a `// test seam`
line above the export, or a `_forTests` suffix on something that exists only for a test
(`_pendingBeeForTests`, `_encodeTicketForTests`).

**Headers.** A file header states the module's job and its load-bearing rules in a few lines. If
your header is over ~15 lines, it is burying the rule — compress it, or move a design essay to
`.claude/`.

---

## 6. Anti-patterns to avoid

Each of these was found in this codebase. Named so they can be called out in review.

- **God-module.** One file accumulating every new handler (`worker/main.js`: 21 responsibilities;
`main/main.js`: 15). *Instead:* a `registerX(ipc, deps)` module per domain.
- **God-screen.** A React screen holding derivation, eight modal slots and three error policies
(`FolderView`, `SpaceView`). *Instead:* pure derivation in a Node-tested module; one hook per
concern; the screen renders.
- **Re-export shim.** A one-line file existing only as an import path. *Instead:* importers name the
real module. All such shims have been deleted.
- **Hand-mirrored vocabulary.** The renderer keeping its own copy of a data-layer rule because it
"cannot import the worker". *Instead:* put it in `contract/` and import it. Pinned by
`test/unit/no-hand-mirrored-vocabularies.test.js`.
- **Two names for one object.** `CODES` and `ErrorCodes` for the same export. *Instead:* one name,
renamed everywhere in a single change.
- **Word collision across domains.** *presence*, *health*, *diagnostics*, *admission* meaning two
things each. *Instead:* see §2.
- **Bug archaeology in comments.** See §5.
- **The same invariant restated per site.** See §5 rule 7.
- **Speculative generality.** A polymorphic backend list with one implementation; lifecycle hooks
(`init`/`attach`/`teardown`) nothing calls; a `refresh` escape hatch no consumer uses. *Instead:*
write the concrete call. Add the seam when the second implementation exists.
- **Dead code kept alive by its own test.** A symbol with no production caller and a passing unit
test reads as live API. *Instead:* delete it with its test, or route the test through the
production path and mark the seam.
- **Timer armed at import.** See §4.
- **Module-level flag nothing clears.** A stop flag that survives a restart — the shutdown-latch bug
class. *Instead:* subsystem-owned state.
- **Primitive obsession on the wire.** Passing a bare status string where a declared vocabulary
exists in `contract/statuses.js`.
- **Unused parameter kept for shape.** Every caller pays to pass it. Drop it.
- **Locale keys and colour tokens outliving their use.** Guarded now by
`test/unit/i18n-unreferenced-keys.test.js` and `test/unit/unused-color-tokens.test.js` — do not
add an allowlist entry to silence them unless the key really is reached dynamically, and name the
site when you do.

Known open issues, recorded rather than fixed here: `knip` still reports ~15 unused exports, of
which the `src/main` rows are false positives from dependency injection and inline `require()` (see
`.claude/dependency-updates.md`); `EVENTS` and `broadcastPresence` are exported but used only
in-file and could be un-exported when their modules are next touched.

---

## 7. Established patterns to reuse

Copy these rather than inventing a parallel mechanism.

- **Table-driven request surface.** `ipc.handle` → `table.register` throws on an undeclared name;
handlers and contract rows are pinned equal by `test/unit/main-request-parity.test.js`. Add a row
when you add a handler.
- `**Subsystem` + owned timers + supervisor.** `_open()` / `_close()`, `health()`, `this.timers`.
Reference: `src/shared/core/` and `src/worker/boot.js`'s partial-root handoff.
- **Composition-root tests.** `test/helpers/store.js`'s `freshPeer` boots the production wiring
(`boot(config, { swarm: false })`); `root.close()` is the production stop. Use `freshDurable` when
the subject is work `boot()` itself does.
- **Shared step order instead of a second implementation.** `worker/ipc/space-leave.js` and
`shared/spaces/leave-flow.js` share `LEAVE_PHASES` + `runLeaveTeardown`, so the live path and
boot's interrupted-leave pass cannot drift.
- **Zero-import contract package.** `src/shared/contract/` — one declaration per vocabulary, frozen
(`Object.freeze`), with a `.d.ts` twin pinned by `contract-declarations.test.js`.
- **Query store with scope-predicate invalidation.** `src/renderer/store/` — `useQuery` for worker
data, `useMainQuery` for main-process facts (`write` replaces, `patch` merges). `loading` means
*cold*, and re-raises on refetch — never gate a subtree on it.
- **Modal contract.** `Modal` + `ModalHeader` + `modalKeys`, with guard tests. New dialogs compose
these; they do not hand-roll padding or a ⌘Enter handler.
- **Errors.** Throw `AppError` with a `CODES.*` code from `contract/errors.js`; classify I/O faults
through `classifyLocalIoFault` / `classifyTransferError` rather than matching `err.message`.
- **Lint rules as executable invariants.** `eslint.config.mjs` exports its selector arrays
(`rendererStatusRestrictions`, `moduleLevelTimerRestrictions`, `pureFolderPolicyModules`, …) and a
unit test parses the same grammar. When you find a rule worth stating, encode it here instead of
writing it in twelve file headers.

---

## 8. Definition of done

A change is not done until all of these hold.

- [ ] **Tests at the layers the change touches** — pure logic → Unit; single-peer data layer →

  Integration; P2P → Flow; renderer UI → Frontend **+ accessibility**. Bug fixes are **red-first**:
  add a failing `REGRESSION (…)` test at the bug's layer before fixing. Docs/config-only → state `SKIP`.
- [ ] `**npm run typecheck**` clean; no new `any`/`unknown`.
- [ ] `**npm run lint**` — 0 errors, and no *new* warnings (the `lint:ci` ceiling is a downward ratchet).
- [ ] `**bash scripts/check-comment-hygiene.sh**` exits 0.
- [ ] `**npm run test:unit**` and, for data-layer changes, `**npm run test:bare**` green.

  (`test:bare` names the file that failed — re-run that one file, `node test/bare-runner.mjs <file>`, not the suite.)
- [ ] **UI changes:** `npm run test:fe` run locally and green (CI cannot drive the AX tree), plus the

  a11y spot-check — keyboard, focus-visible, accessible name/role/state, `prefers-reduced-motion`.
  If `agent-desktop` cannot target a control by name/role, that is an a11y gap in the control.
- [ ] **No duplicated logic** left behind — extracted to the layer both callers reach.
- [ ] **No new file that only re-exports another.**
- [ ] **Comments reviewed against §5** — rules not history, no ids, no plan refs, no restating code.
- [ ] **Names checked against §2** — no new word collisions.
- [ ] **Placed per §3** — domain folder, correct runtime, purity respected.
- [ ] **Dead code removed in the same change**, including its `.d.ts` declaration and any test that

  exists only to keep it alive.
- [ ] **Docs updated in the same change** when a rule, module table, or convention moved

  (`.claude/solution-architecture.md`, `.claude/testing.md`, and this file).
- [ ] **Commit message**: `[type] Short imperative title` (`[feat]`, `[fix]`, `[chore]`, …), ≤ ~60

  chars, blank line, one short paragraph of context. No AI attribution.

---

## 9. Keeping this file current

`coding.md` is the canonical home for this repository's coding standards — not a scratch file, and
not a snapshot. When a cleanup, review, or architecture decision meaningfully changes a convention,
**update this file in the same change**. When a rule here becomes mechanically enforceable, encode
it in `eslint.config.mjs` or a `test/unit` guard and link it from the rule. A rule that CI can check
belongs in CI; this file is for the ones a reader has to hold.