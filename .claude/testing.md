# Testing & Accessibility Discipline

**The bar (Definition of Done):** a feature or change to existing behavior is not "done" until it is covered by tests at the layer(s) it touches, those tests fail before the change and pass after, the automated suites are green, and any UI it adds or changes meets the accessibility bar. Bug fixes additionally carry a **red-first regression test** labeled `REGRESSION (FIX-N: …)` at the layer the bug lived. Docs/comment/config-only changes have no runtime surface — state `SKIP` and say why.

This is not "all layers for every change." Use the matrix in §3 to pick the layers a given change actually touches.

---

## 1. Test layers

| Layer | Lives in | Runner | What it covers |
|---|---|---|---|
| **Unit** | `test/unit/*.test.js` | `brittle-node` (Node) | Pure logic, no I/O: validators, encoders/decoders, IPC dispatch, ignore-matchers, invite envelopes, runtime-config. |
| **Integration** | `test/integration/*.test.js` | `brittle-bare -j 4` (Bare) | Single-process data layer with real `bare-*`/corestore/hyperdrive: owned-folder publish, mount validate, cleanup-orphans, witness-prune. |
| **Flow (two-peer)** | `test/flow/*.test.js` | `brittle-node` orchestrating real worker subprocesses over a hermetic `hyperdht/testnet` | End-to-end P2P between two peers: membership, transfers, owned folders, foreign mirror, leave/reconcile, download collision, mirror reclaim. |
| **Frontend (UI)** | `test/frontend/scenarios/*.mjs` | `node test/frontend/run.mjs` driving the real Electron app via `agent-desktop` | User-facing flows through the rendered UI + re-verification of behavior fixes through the UI. **Runnable on any dev machine — including by the coding agent (verified).** Only *CI* can't (headless has no AX tree); that is never a reason to skip writing or running them. |

Run: `npm test` (unit+integration), `npm run test:node`, `npm run test:bare`, `npm run test:fe` (UI, local), `npm run test:unit`.

**Layer = what the module *imports*, not how pure the function is.** Anything reachable from `src/shared/**` or `src/worker/**` that pulls in a `bare-*` module (`bare-fs`, `bare-path`, …) loads only under Bare → it's an **Integration** test (`brittle-bare`/`test:bare`), never Unit or `test/raw` (Node). Even a genuinely pure helper crashes under Node if its module imports `bare-fs` at module scope — and a misplaced file takes down its whole runner's suite, not just itself. `test/unit` is for genuinely Node-loadable pure logic (runtime-config, handshake-guard).

> **Frontend tests are runnable locally — there is no excuse to skip them.** `npm run test:fe` launches the real app and drives it via `agent-desktop`; the coding agent runs it directly (proven — the MIR-01 membership-approval scenarios were authored *and* executed this way, and caught a real gate-bypass bug client-side invites). **Every new or changed user flow, for any feature or enhancement, ships with a `test/frontend/scenarios/*.mjs` scenario that exercises it through the UI — and you run it and confirm it passes before the change is "done."** Setup, if the harness "won't start": `agent-desktop@>=0.3.0` on PATH (older 0.2.x re-resolved refs cross-process and returned `STALE_REF`; `run.mjs` enforces `MIN_AGENT_DESKTOP` via `preflight.mjs`) with Accessibility + Screen-Recording granted; `node_modules/electron` must contain its downloaded binary (`npm rebuild electron` if a prior `npm install --ignore-scripts` skipped it); and register the new scenario in `test/frontend/run.mjs`. Multi-peer flows (e.g. approval needs a creator + joiners) launch N `Instance`s with `total: N`. Evidence screenshots land in `test/frontend/evidence/`.

## 2. Accessibility (cross-cutting — every UI change)
Any new or changed renderer UI must remain fully usable by keyboard and assistive tech. No a11y regressions.

- **Static gate (CI, automatic):** `eslint-plugin-jsx-a11y` runs via `npm run lint:ci` in CI (and `npm run lint`, part of `npm run build`, locally). It must pass — it catches `<div onClick>` without role/keyboard, missing labels, invalid ARIA.
- **Runtime gate (dev):** `@axe-core/react` logs WCAG violations to the console in dev (`window.bridge.isDev()`); a UI change should add **zero** new serious/critical violations.
- **AX-targetability (doubles as a11y proof):** the frontend suite can only address an element if it has an accessible name + role + state. If a control isn't reachable by `agent-desktop` (name/role/`aria-pressed`/`aria-checked`), it's an a11y gap — fix the control, not the test. (This is how the empty-named theme/zoom buttons were caught.)
- **One logical string = one accessible node.** A component that splits visible text across multiple DOM nodes for truncation (name stem + extension, path segments) must still expose the whole string as ONE node: `aria-hidden="true"` the visible fragment spans + a sibling `<span className="sr-only">{full}</span>` (sr-only uses `clip`, not `display:none`, so it stays in the AX tree). macOS otherwise surfaces each fragment as a separate `AXStaticText` leaf — VoiceOver reads it in pieces (a real regression) and `waitText('name.ext')` can't match the split substring. A `title`/`aria-label` on a role-less text span does NOT reach the AX tree. Fix the whole class, not one instance.
- **Manual spot-check for significant UI:** Tab order + focus-visible, the control has a name/role, dynamic status is announced (`aria-live`/`role=status|alert`), `prefers-reduced-motion` respected, VoiceOver reads it sensibly.

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

When a fix's precise guarantee isn't cleanly observable at a higher layer (e.g. byte-level cache reclaim, boot-time cleanup), assert it at the layer that *can* (usually Flow/Integration) and verify the **user-facing outcome** at the UI layer. Don't force a flaky UI assertion.

**Coverage blind spots to design around:**
- **Data-polling flow tests can't catch a missing IPC event** — they read the same converged data the event would surface, so an event-driven UI refresh (e.g. `event:shares-updated` on a peer profile-bee append) that stops firing still passes every `share:list` poll. Only the Frontend suite (or a flow test that explicitly `waitFor`s the event) covers it. When you rename/split an `event:*`, grep `test/flow` for the old name first — waits block to timeout, not fail fast — and typecheck can't help (worker JS + harness aren't typechecked).
- **A two-mode subsystem must exercise its production-default mode in destructive/lifecycle paths** (leave, purge, migrate, restart), not just happy-path read/write. A swallowed teardown error resolves `{ok:true}` and only kills the *next* call, so the regression test must do a follow-up op or assert the authoritative record is actually deleted. Don't rely on stderr/console errors to fail a test.

## 4. How it's enforced

- **CI (automatic, every PR):** `.github/workflows/test.yml` runs three jobs: **node** (`typecheck` + `lint:ci` [jsx-a11y + a `--max-warnings` ceiling + comment-hygiene] + `knip` [advisory] + `test:node:core` = unit + `test/raw`), **flow** (`test:flow` sharded 6×), and **bare** (`test:bare` = integration). Green CI is required to merge.
- **Local (you run it — not optional):** `npm run test:fe` is **required** for any UI-affecting change and runs fine on a dev machine (only CI can't drive the AX tree). Run it, confirm it's green, plus the manual a11y spot-check. Capture the evidence (the suite writes screenshots to `test/frontend/evidence/`) and note which UI flows were exercised.
- **PR body:** `.github/pull_request_template.md` asks only for what CI cannot check — which layers the change touches (and why an obvious one is skipped), plus the local-only runs: `test:fe` and which flows it exercised, dev axe, VoiceOver. Everything CI already enforces is deliberately absent from it; restating a machine-verified fact in prose is noise, and a checklist of them trains people to tick without reading.
- **AI-assisted work:** adding the appropriate-layer tests + a11y check is part of the change itself (see `CLAUDE.md` → Testing & Accessibility Discipline), not a follow-up.

## 5. Frontend scenario authoring (agent-desktop)

Hard-won rules for `test/frontend/scenarios/*.mjs` that otherwise silently pass:

- **Size the file so the transfer OUTLASTS the multi-step UI action.** A small download (64–256 MB) finishes over loopback before a menu→click→confirm sequence (≈3–6s) lands, so the "mid-transfer" case never actually runs. Use 256 MB–1 GB, start the action as early as possible, and assert the mid-download precondition explicitly (`assert(!hasText('On your device'))`) so a regression fails loudly instead of as a confusing missing-toast. A *completed* transfer is a real, often-correct outcome with a DIFFERENT/absent signal (e.g. no "removed by the owner" toast once `isDownloadedFile`). When the deterministic guarantee is a state change (folder→"unavailable", owner row gone), assert THAT and demote byte-checks to logged observations.
- **Owner offline→online resume needs a real EDGE, not just a restart.** Use `quit()` → wait for the peer to show "Owner offline" → `launch({onboard:false})`; a no-gap `relaunch()` returns before the downloader registers the outage, so auto-resume never triggers. `kill()` (SIGKILL) vs graceful `quit()` produce DIFFERENT durable states (hard-kill mid-index leaves the loose entry ABSENT on reboot) — confirm the post-crash state by observation before writing the invariant.
- **A control gated on an async probe must be reached with `waitText`/`waitFor` on the control itself, never a fixed sleep.** A control behind a feature flag needs BOTH the flag (to exist) AND a wait for the async `features:get` probe (to render); a fixed sleep in the helper races the probe, so wait on the control: open the modal → `waitText('<section heading>')` → `click({name:'<control>'})`. When an AX-name lookup "isn't there," dump `allText(await snap())` to see what actually rendered before theorizing about flags — the control may have been removed outright rather than gated off.
- **Split visible text breaks `waitText`** — expose the full string as one `sr-only` node (see §2). Run `test:fe` for any change to how user-visible text renders: typecheck/lint/unit all pass while the live AX behavior is broken.
- **Before bumping a scenario timeout, prove the failure IS a timeout** — raise it once; if it still fails at a generous bound the asserted state is ABSENT, not late, so stop bumping and find the gating precondition (cross-check the flow/integration test for the setup it uses). "Row never renders" usually means a gate is false, not that the UI is slow.
- **Rapid repeated Electron launches wedge the macOS accessibility API.** The app renders normally but its web-AX subtree vanishes, so every scenario times out identically — an OS-level wedge, not a code bug, and not something a longer timeout fixes. Reap stray Electron / `agent-desktop` processes to recover, and bound a hung AX call with a `perl` alarm wrapper (`timeout` does not interrupt the blocking AX syscall).
