# Testing & Accessibility Discipline

**The bar (Definition of Done):** a feature or change to existing behavior is not "done" until it is
covered by tests at the layer(s) it touches, those tests fail before the change and pass after, the
automated suites are green, and any UI it adds or changes meets the accessibility bar. Bug fixes
additionally carry a **red-first regression test** labeled `REGRESSION (FIX-N: …)` at the layer the
bug lived. Docs/comment/config-only changes have no runtime surface — state `SKIP` and say why.

This is not "all layers for every change." Use the matrix in §3 to pick the layers a given change
actually touches.

---

## 1. Test layers

| Layer | Lives in | Runner | What it covers |
|---|---|---|---|
| **Unit** | `test/unit/*.test.js` | `brittle-node` (Node) | Pure logic, no I/O: validators, encoders/decoders, IPC dispatch, ignore-matchers, invite envelopes, runtime-config. |
| **Invariants** | `test/invariants/*.test.js` | `brittle-node` (Node) | Guards that read the SOURCE rather than run it: contract parity, single-owner rules, ratchets, boundary and vocabulary checks, every `src/` path the `.claude/` docs name. A file belongs here when it scans `src/**` and imports nothing from it — one that also drives the module it scans stays in `test/unit`. `test/typecheck/*.ts` are compile-time assertions that `npm run typecheck` reads and no runner executes: each `@ts-expect-error` line pins a value a contract union must reject. `test/typecheck/worker/*.ts` belong to the worker program (`tsconfig.worker.json`) and pin what a handler may return and read. |
| **Integration** | `test/integration/*.test.js` | `test/bare-runner.mjs` — one `brittle-bare` PROCESS per file (Bare) | Single-process data layer with real `bare-*`/corestore/hyperbee: owned-folder publish, mount validate, cleanup-orphans, witness-prune. |
| **Flow (two-peer)** | `test/flow/*.test.js` | `test/flow-runner.mjs` (brittle) orchestrating real worker subprocesses over a hermetic `hyperdht/testnet` | End-to-end P2P between two peers: membership, transfers, owned folders, foreign mirror, leave/reconcile, download collision, mirror reclaim. |
| **Frontend (UI)** | `test/frontend/scenarios/*.mjs` | `node test/frontend/run.mjs` driving the real Electron app via `agent-desktop` | User-facing flows through the rendered UI + re-verification of behavior fixes through the UI. **Runnable on any dev machine — including by the coding agent (verified).** Only *CI* can't (headless has no AX tree); that is never a reason to skip writing or running them. |

Run: `npm test` (unit+integration), `npm run test:node`, `npm run test:bare`, `npm run test:fe` (UI,
local), `npm run test:unit` (unit + invariants).

**Why the flow layer has its own runner.** brittle rejects a test's promise when its body throws
rather than asserting on it, and nothing awaits that promise: an escaping throw — the shape every
timed-out `until()`/`waitFor()` takes — is an unhandled rejection that kills the process with no
`not ok` and no named test, and the tests behind it never run. `test/flow-runner.mjs` records a
throwing body as a named `not ok` and carries on, turns a mid-run death into a non-zero exit, and
accounts for every registered test at exit, printing
`# flow accounting: N/N registered test(s) executed`. A run whose last line is not `N/N` was
truncated and fails. It delivers those guarantees by wrapping a brittle internal, so it asserts that
internal's shape at startup and refuses to run a suite it could not wrap — a `brittle` bump that
moves the seam stops the run loudly instead of silently reinstating the defect.
`test/unit/flow-runner.test.js` drives the runner over fixtures in `test/fixtures/flow-runner/`.

**Why the bare layer has its own runner too.** brittle's `-j` is threads inside ONE process
(`brittle/lib/threads.js` → `new Bare.Thread`): one fd table, one file-lock namespace, one heap for
200 files. A single file's unhandled rejection aborts that process — under Bare with SIGABRT, before
any summary — so the log names no test, no file and no totals, and the other 199 files' results are
lost with it. `test/bare-runner.mjs` runs one bare process per file, `--jobs` of them at a time, so
a death is attributable to its file and bounded to it. It fails a file that exits 0 without a
brittle summary, and one that registered no tests — both of which an exit-code check reads as a
pass. `--retries 1` re-runs only the failed files, one at a time, and `--report` writes the same
flake-ledger record the flow shards write. `test/unit/bare-runner.test.js` drives it over fixtures
in `test/fixtures/bare-runner/`.

**Deadlines in an integration test scale.** `MIRALL_TEST_TIMEOUT_SCALE` is set to 3 on the bare job,
as it is on flow. Bare has no `process`, so the scale is read through `test/helpers/bare-timing.js`
(`bare-os.getEnv`) rather than `test/helpers/timing.js`; the contract is the same one — a wait
helper scales the `ms` it RECEIVES, so call sites pass dev-box base values.
`scripts/ci/check-test-timing.sh` fails lint on an un-scaled poll deadline, settle window or
per-test `{ timeout }` in `test/integration`. Two kinds of wait stay absolute and say so with an
`absolute:` comment, which is the gate's only opt-out: a budget passed INTO the code under test
(`fetchFile({ timeout: 6000 })`), which is the assertion, and a yield that has to land INSIDE an
un-scaled production window — scaling one of those moves it past the very edge under test.

**How an integration test boots.** `test/helpers/store.js`'s `freshPeer` runs the worker's own
composition root — `boot(config, { swarm: false })` — so a test drives the production wiring rather
than a hand-rolled subset of it, and `root.close()` in teardown is the production stop. The store
sits at `<peerDir>/app-storage`, mirroring production, because `identity.enc` and `space-keys.enc`
are written to `dirname(storage)` and a flat tmpdir would share them between peers. The root's
teardown is registered with `{ order: 1 }`: brittle sorts teardowns and runs the default `order: 0`
ones first, so a test's own teardown still has a live data layer. Use **`freshDurable`** (or
`freshDurableWithIdentity`) when the test's subject is work `boot()` itself does — a content
migration, the manifest caps — which must not already have run; it starts the durable tier and
nothing else. The overlay comes up with the root too, so a test that needs it neither calls
`initOverlay()` nor resets anything in teardown: there are no `_reset*` seams left in `src/`. A test
that starts a subsystem of its own **closes it in `t.teardown`**; `test/helpers/timers.js`'s
`trackTimers()` is the tool for proving nothing is left armed (install it before the imports under
test, restore it in teardown).

**Layer = what the module *imports*, not how pure the function is.** Anything reachable from
`src/shared/**` or `src/worker/**` that pulls in a `bare-*` module (`bare-fs`, `bare-path`, …) loads
only under Bare → it's an **Integration** test (`brittle-bare`/`test:bare`), never Unit or
`test/raw` (Node). Even a genuinely pure helper crashes under Node if its module imports `bare-fs`
at module scope — in `test/unit` that takes the whole Node runner with it; in `test/integration` the
bare runner bounds it to the one file and names it. `test/unit` is for genuinely Node-loadable pure
logic (runtime-config, handshake-guard).

> **Frontend tests are runnable locally — there is no excuse to skip them.** `npm run test:fe`
> launches the real app and drives it via `agent-desktop`; the coding agent runs it directly (proven
> — the MIR-01 membership-approval scenarios were authored *and* executed this way, and caught a
> real gate-bypass bug client-side invites). **Every new or changed user flow, for any feature or
> enhancement, ships with a `test/frontend/scenarios/*.mjs` scenario that exercises it through the
> UI — and you run it and confirm it passes before the change is "done."** Setup, if the harness
> "won't start": `agent-desktop@>=0.3.0` on PATH (older 0.2.x re-resolved refs cross-process and
> returned `STALE_REF`; `run.mjs` enforces `MIN_AGENT_DESKTOP` via `preflight.mjs`) with
> Accessibility + Screen-Recording granted; `node_modules/electron` must contain its downloaded
> binary (`npm rebuild electron` if a prior `npm install --ignore-scripts` skipped it); and drop the
> new scenario into `test/frontend/scenarios/` as `sNN-<slug>.mjs` — the directory is the registry
> (`scenarios/index.mjs`), there is no list to edit. Multi-peer flows (e.g. approval needs a
> creator + joiners) launch N `Instance`s with `total: N`. Evidence screenshots land in
> `test/frontend/evidence/`.

## 2. Accessibility (cross-cutting — every UI change)
Any new or changed renderer UI must remain fully usable by keyboard and assistive tech. No a11y
regressions.

- **Static gate (CI, automatic):** `eslint-plugin-jsx-a11y` runs via `npm run lint:ci` in CI (and
  `npm run lint`, part of `npm run build`, locally). It must pass — it catches `<div onClick>`
  without role/keyboard, missing labels, invalid ARIA.
- **Runtime gate (dev):** `@axe-core/react` logs WCAG violations to the console in dev
  (`window.bridge.isDev()`); a UI change should add **zero** new serious/critical violations.
- **AX-targetability (doubles as a11y proof):** the frontend suite can only address an element if it
  has an accessible name + role + state. If a control isn't reachable by `agent-desktop`
  (name/role/`aria-pressed`/`aria-checked`), it's an a11y gap — fix the control, not the test. (This
  is how the empty-named theme/zoom buttons were caught.)
- **One logical string = one accessible node.** A component that splits visible text across multiple
  DOM nodes for truncation (name stem + extension, path segments) must still expose the whole string
  as ONE node: `aria-hidden="true"` the visible fragment spans + a sibling
  `<span className="sr-only">{full}</span>` (sr-only uses `clip`, not `display:none`, so it stays in
  the AX tree). macOS otherwise surfaces each fragment as a separate `AXStaticText` leaf — VoiceOver
  reads it in pieces (a real regression) and `waitText('name.ext')` can't match the split substring.
  A `title`/`aria-label` on a role-less text span does NOT reach the AX tree. Fix the whole class,
  not one instance.
- **Manual spot-check for significant UI:** Tab order + focus-visible, the control has a name/role,
  dynamic status is announced (`aria-live`/`role=status|alert`), `prefers-reduced-motion` respected,
  VoiceOver reads it sensibly.

## 3. What coverage a change needs

| Change type | Required coverage |
|---|---|
| Pure shared logic / helper / validator (`src/shared`, no I/O) | **Unit** |
| Worker / data-layer behavior, single peer | **Integration** (+ Unit for any extracted pure logic) |
| P2P behavior (sync, transfer, membership, mirror, leave, reclaim) | **Flow (two-peer)** (+ Integration where a single-peer assertion is enough) |
| IPC contract (new/changed channel or payload) | **Unit** (ipc/schema) + the behavior layer it drives |
| New/changed renderer component, screen, or flow | **Frontend** (mandatory — write the scenario *and run it*) + **Accessibility** (+ Unit for testable hook/util logic) |
| New user-facing feature (spans data layer + UI) | All applicable: **Unit + Integration/Flow + Frontend + Accessibility** |
| Bug fix (any layer) | **Red-first `REGRESSION` test** at the bug's layer + the normal layer coverage |
| Docs / comments / config only | None — `SKIP`, say why |

When a fix's precise guarantee isn't cleanly observable at a higher layer (e.g. byte-level cache
reclaim, boot-time cleanup), assert it at the layer that *can* (usually Flow/Integration) and verify
the **user-facing outcome** at the UI layer. Don't force a flaky UI assertion.

**Coverage blind spots to design around:**
- **Only the frontend suite drives the real chokidar → publish → replicate → materialize path.**
  Every other layer stubs the watcher in main, so a break between a disk event and a peer's
  materialized file shows up nowhere else.
- **Data-polling flow tests can't catch a missing IPC event** — they read the same converged data
  the event would surface, so an event-driven UI refresh (e.g. `event:shares-updated` on a peer
  profile-bee append) that stops firing still passes every `share:list` poll. Only the Frontend
  suite (or a flow test that explicitly `waitFor`s the event) covers it. When you rename/split an
  `event:*`, grep `test/flow` for the old name first — waits block to timeout, not fail fast — and
  typecheck can't help (event names are not typed at the emit site, and the harness is not
  typechecked).
- **A relaunched worker can consume an edge inside its own boot.** A pending joiner knocks from the
  swarm start, so a deny or grant can arrive and be applied before `worker-ready`. The flow harness
  keeps events emitted before `launchPeer` resolves and hands them to the caller's first matching
  `waitFor` (once each); any *other* edge must have its wait attached before the action that
  triggers it, and a level (`until` on `spaces:list` / `share:list`) is preferable where one exists.
  `launchPeer`'s `bootSettleMs` holds the boot window open when a test needs the in-boot delivery to
  be certain.
- **A two-mode subsystem must exercise its production-default mode in destructive/lifecycle paths**
  (leave, purge, migrate, restart), not just happy-path read/write. A swallowed teardown error
  resolves `{ok:true}` and only kills the *next* call, so the regression test must do a follow-up op
  or assert the authoritative record is actually deleted. Don't rely on stderr/console errors to
  fail a test.

## 4. How it's enforced

- **CI (automatic, every PR):** `.github/workflows/test.yml` runs four jobs: **node** (`typecheck` +
  `lint:ci` [jsx-a11y + a `--max-warnings` ceiling + comment-hygiene] + `knip` [advisory] +
  `test:node:core` = unit + invariants + `test/raw`), **flow** (`test:flow` sharded 6×), **bare**
  (integration, sharded 4x, `MIRALL_TEST_TIMEOUT_SCALE=3`, one process per file with a single retry
  of a failed file), and **flake-ledger**, which grades each suite's pass-on-retry count against its
  own `test/<suite>-flake-budget.json`. Green CI is required to merge.
- **Local (you run it — not optional):** `npm run test:fe` is **required** for any UI-affecting
  change and runs fine on a dev machine (only CI can't drive the AX tree). Run it, confirm it's
  green, plus the manual a11y spot-check. Capture the evidence (the suite writes screenshots to
  `test/frontend/evidence/`) and note which UI flows were exercised.
- **PR body:** `.github/pull_request_template.md` asks only for what CI cannot check — which layers
  the change touches (and why an obvious one is skipped), plus the local-only runs: `test:fe` and
  which flows it exercised, dev axe, VoiceOver. Everything CI already enforces is deliberately
  absent from it; restating a machine-verified fact in prose is noise, and a checklist of them
  trains people to tick without reading.
- **AI-assisted work:** adding the appropriate-layer tests + a11y check is part of the change itself
  (see `CLAUDE.md` → Testing & Accessibility Discipline), not a follow-up.

## 5. Frontend scenario authoring (agent-desktop)

Hard-won rules for `test/frontend/scenarios/*.mjs` that otherwise silently pass:

- **Size the file so the transfer OUTLASTS the multi-step UI action.** A small download (64–256 MB)
  finishes over loopback before a menu→click→confirm sequence (≈3–6s) lands, so the "mid-transfer"
  case never actually runs. Use 256 MB–1 GB, start the action as early as possible, and assert the
  mid-download precondition explicitly (`assert(!hasText('On your device'))`) so a regression fails
  loudly instead of as a confusing missing-toast. A *completed* transfer is a real, often-correct
  outcome with a DIFFERENT/absent signal (e.g. no "removed by the owner" toast once
  `isDownloadedFile`). When the deterministic guarantee is a state change (folder→"unavailable",
  owner row gone), assert THAT and demote byte-checks to logged observations.
- **Owner offline→online resume needs a real EDGE, not just a restart.** Use `quit()` → wait for the
  peer to show "Owner offline" → `launch({onboard:false})`; a no-gap `relaunch()` returns before the
  downloader registers the outage, so auto-resume never triggers. `kill()` (SIGKILL) vs graceful
  `quit()` produce DIFFERENT durable states (hard-kill mid-index leaves the loose entry ABSENT on
  reboot) — confirm the post-crash state by observation before writing the invariant.
- **A control gated on an async probe must be reached with `waitText`/`waitFor` on the control
  itself, never a fixed sleep.** A control that renders only once an async probe answers (e.g. one
  gated on `network:status:get`) needs a wait for that probe; a fixed sleep in the helper races it,
  so wait on the control: open the modal → `waitText('<section heading>')` →
  `click({name:'<control>'})`. When an AX-name lookup "isn't there," dump `allText(await snap())` to
  see what actually rendered before theorizing about gates — the control may have been removed
  outright rather than gated off.
- **Split visible text breaks `waitText`** — expose the full string as one `sr-only` node (see §2).
  Run `test:fe` for any change to how user-visible text renders: typecheck/lint/unit all pass while
  the live AX behavior is broken.
- **Before bumping a scenario timeout, prove the failure IS a timeout** — raise it once; if it still
  fails at a generous bound the asserted state is ABSENT, not late, so stop bumping and find the
  gating precondition (cross-check the flow/integration test for the setup it uses). "Row never
  renders" usually means a gate is false, not that the UI is slow.
- **Rapid repeated Electron launches wedge the macOS accessibility API.** The app renders normally
  but its web-AX subtree vanishes, so every scenario times out identically — an OS-level wedge, not
  a code bug, and not something a longer timeout fixes. Reap stray Electron / `agent-desktop`
  processes to recover, and bound a hung AX call with a `perl` alarm wrapper (`timeout` does not
  interrupt the blocking AX syscall).
- **A trigger that opens something can be LOST, so re-fire it instead of waiting longer.** Keyboard
  triggers are delivered to whatever process is frontmost at that instant, so a sibling instance
  mid-launch or mid-teardown eats them, and the menu items behind `⌘U` / `⌘⇧U` are
  `enabled: inSpace` — disabled, and silently inert, until the renderer's `menu:context-changed` IPC
  lands. Both cases look identical to "slow": nothing appears, and the wait expires. Distinguish
  them by measuring the happy path (a native Open panel that IS coming takes ~1.6s against a 20s
  budget) — a wait many times the normal latency that comes back empty means the trigger never
  landed, and a longer deadline cannot help. Structure such helpers to own their trigger and re-fire
  it across a few shorter attempts (`nativeChoosePath({trigger})`), keeping the same total budget;
  re-firing is safe because it only runs while nothing is up.

## 6. Lint invariants (`eslint.config.mjs`)

Each `no-restricted-syntax` table in `eslint.config.mjs` is exported so a unit test can run the same
grammar through eslint's parser; the config keeps the selector and one line of why. The reasoning,
and the history that produced each rule, lives here.

- **Renderer status invariant** (`rendererStatusRestrictions`;
  `test/invariants/renderer-status-invariant.test.js`). Event handlers decorate rows — progress,
  `verifyFraction` — and never construct row STATUS: status is worker-derived per read
  (level-triggered), so a handler that builds one re-creates the edge-triggered divergence the EDA
  alignment removed. The selector is scoped to an `ObjectExpression` so destructured READS of a
  payload's status stay legal; a second selector closes the quoted/computed-key bypass.
- **No timer armed at import** (`moduleLevelTimerRestrictions`;
  `test/invariants/module-level-timers.test.js`). A `setTimeout`/`setInterval` with no function
  ancestor runs at import, so no `close()` can reach it. This is the import-time corner of the
  lifecycle rule and only that: the broad property — every periodic call dies with its subsystem —
  is not decidable statically (three of the eleven module-scoped handles in the data layer belong to
  module singletons that are not Subsystems), so it is measured at runtime by
  `test/integration/timer-lifecycle.test.js`, with
  `test/invariants/module-scoped-timer-handles.test.js` as the decidable static companion. The
  rule's message deliberately does not promise the broad property — an earlier wording did, and read
  as a guarantee no selector can give.
- **No un-owned timer handle** (`moduleScopeTimerHandleRestrictions`). The shape the rule above
  cannot see, and the one that slipped past it twelve times: a timer armed inside a function but
  held in a long-lived handle (`announceTimer = setTimeout(…)`, `this.sweepTimer = setInterval(…)`).
  The handle outlives every call, so nothing scoped to a call clears it. The storage is not the
  defect, arming from the global is: `x = timers.setTimeout(…)` / `this.timers.` is owned and does
  not match, which is why the twelve migrated sites keep their bindings. The name pattern is the
  camelCase COMPOUND (`*Timer`, `*Beat`), never a bare `timer` — three legitimate function-local
  `timer` variables are owned by their function. Known blind spot: a module-scope handle called
  `pending` or `h` slips through; the rule's job is to stop the thirteenth, and a genuine exception
  is one inline disable with a reason next to it.
- **chokidar has one owner** (`chokidarSingleOwnerRestrictions`;
  `test/invariants/watch-host-single-owner.test.js`). chokidar's options are per-INSTANCE, not
  per-path, and its sharp edges — native events never reach a network mount, an erroring watcher
  spins forever — were learned once on the owned-folder watcher and never carried to the loose-file
  watcher, so a file shared from `/Volumes`, `/mnt`, `/media` or a UNC path silently stopped
  re-publishing. `src/main/watch-host.js` owns every chokidar decision; a second
  `require('chokidar')` is exactly how that divergence comes back.
- **One byte ladder** (`byteFormatterSingleOwnerRestrictions`;
  `test/invariants/byte-formatter-single-owner.test.js`). `src/renderer/format/bytes.js` owns the
  decimal (SI) ladder because the divisor and the labels have to agree: `model/audit-row.js` grew a
  binary-divided ladder under KB/MB/GB labels, so the Activity Log printed every size ~7.4% low
  while every other screen printed it right, and a unit test pinned the wrong numbers. A unit-ladder
  array literal is the shape a re-implementation always takes, whatever it is named, so the selector
  matches the literal.
- **No unguarded async effect** (`local/no-unguarded-async-effect` in
  `eslint-rules/no-unguarded-async-effect.js`; exemption tables `unmountOnlyAsyncEffects` /
  `outOfOrderAsyncEffects`). An effect that writes state after an `await` is a race: a response for
  the PREVIOUS deps can land after a newer one and win. The predecessor guard grepped for
  `let cancelled = false` and counted four files; it missed six hand-rolled guards spelled
  `alive`/`active`/`sawFrame`/`runRef` and — the point — could never see an effect with no guard at
  all, which is the only thing forbidden; six such effects were live while it reported the property
  covered. The rule needs reachability from an async boundary to a setter, scope resolution of
  `setX` to a `useState` binding, and one hop into a `useCallback` (the three out-of-order defects
  it was written for all put the work in a `const refresh = useCallback(async …)`), none of which an
  esquery selector can do. `UNMOUNT_ONLY` lists effects with `[]` deps and one in-flight read — the
  only race is a write after unmount, which React tolerates. `OUT_OF_ORDER` must stay empty:
  allowlisting a re-firing effect is a green test over a live defect.
- **`no-undef` on the data layer.** `tsc` reports only `src/renderer` and the `// @ts-check` handler
  modules, so an identifier left behind by a refactor in `src/shared`/`src/worker` resolves to
  nothing and surfaces only as a swallowed runtime warning; two such bugs shipped green through
  every gate before the rule was turned on.
- **No empty catch in a screen or a control** (`no-empty` with `allowEmptyCatch: false` on
  `src/renderer/{screens,components}/**/*.tsx`). A handler there is the end of a user action: a
  swallowed rejection is a click that did nothing and said nothing, and the code after an empty
  catch runs as if the call succeeded — the verbose toggle announced "on" over a failed write that
  way. Such a failure goes through `useRunAction`. The rule sees only the literal empty block; the
  two guards below cover what it cannot. Best-effort paths with no user behind them (`platform/`,
  `notifications/`) are outside the glob.
- **No swallowed rejection in the renderer** (`swallowedRejectionRestrictions` on all of
  `src/renderer/**` — no folder is excluded, since `store/`, `platform/` and `ipc/` feed screens
  too; exemption table `swallowedRejectionExemptions`;
  `test/invariants/renderer-promise-lint.test.js`). A catch holding only a comment or a bare
  `return`, and a no-op handed to `.catch` or as `.then`'s second argument (empty body, bare
  `return`, `undefined`, `void 0`, a function named `noop`/`ignore`/`swallow`), are the same silence
  as an empty catch; core `no-empty` exempts the first and cannot see the rest. A fallback value
  (`() => null`) is a decision and stays legal. Each exemption states why no user is waiting on the
  site (mount reads superseded by push frames, liveness pokes, unmount cleanup, re-reads the query
  store already reports).
- **No unhandled promise in the renderer** (typed `@typescript-eslint/no-floating-promises` with
  `ignoreVoid: false` + `no-misused-promises`, via `parserOptions.projectService`; allowlist
  `promiseLintAllowlist`; same test). `void` is flagged on purpose: it is how a dropped failure is
  spelled, not a handler. The typed rules cannot tell a handler that catches internally (a modal
  submit rendering its own inline error) from one that drops, so those sites sit on the allowlist
  with a reason. A listed file turns off only the floating and void-return checks; conditionals and
  spreads stay on. Both tables are exact per-SITE lists keyed by enclosing scopes plus the reported
  code (`test/helpers/lint-site-key.js`), not per-file counts, so fixing one site and adding another
  fails; the test lints only the listed files (`lint:ci` covers the rest), ignores inline config,
  and fails on any `eslint-disable` of these rules in the renderer. A new site reports through
  `useRunAction` inside `ToastProvider` or `InlineError` outside it, and a handler that returns a
  promise to a `() => void` prop is wrapped in `runAction` rather than `void`-ed.
