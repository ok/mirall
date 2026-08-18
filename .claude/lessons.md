# Lessons

Compact, actionable rules distilled from real debugging — gotchas, root causes, and fixes that worked. Grouped by theme; read at session start.

**Write every new lesson in this style.** A lesson is a short **bold imperative claim** followed by 1–4 sentences that carry only what makes the rule usable: the mechanism (why it bites), the diagnostic *tell* (the signal that points at it), and the concrete fix (specific API/formula/sequence). No narrative — drop dates, "the user corrected me", play-by-plays, and one-off test IDs unless the ID is the reusable fix. Put it under the matching `##` theme section (add one only if none fits); merge into an existing lesson rather than duplicating a near-identical one.

**Durable discipline rules live in their discipline doc, not here.** Testing/a11y/scenario-authoring → `testing.md`; visual language → `design.md`; dep-bump debugging → `dependency-updates.md`; architecture → `solution-architecture.md`. This file is for cross-cutting debugging *tactics* and system *gotchas* that don't belong to a single discipline. If a new lesson is really a rule for one discipline, put it there and skip lessons.md.

## Workflow & process

**Plan approval ≠ build approval.** For any task producing >1 file or spanning layers, write a detailed `~/Projects/Mirall/plans/plan-*.md` (with code skeletons) and get an explicit, separate build signal ("go implement", "start coding") before touching code. Approving a plan, answering its open questions, or asking to refine part of it are all still PLANNING. When unsure, ask "shall I start implementing, or keep refining?" — never infer the go-ahead.

**Feature-branch code work always goes in a worktree** (`worktrees/<branch>/`) from the start — no "small enough to skip" exception for code. Only `.claude/` docs and README typos stay in the main checkout. Base a stacked worktree off the active feature branch, not `main`, when the fix depends on in-flight work; re-verify file/line references in the actual target tree if a sub-agent explored a different checkout.

**Session cwd persists across Bash calls.** With two checkouts of one repo (main + worktree), prefix every repo-touching command with an explicit `cd <right-checkout> &&` — a one-off `cd elsewhere && …` silently redirects all later relative-path commands, and wrong-cwd runs succeed convincingly (identical relative paths). Verify from the output: evidence/log paths must contain the `worktrees/` segment; an `ls`/glob-built file list must include the branch's untracked files. A green suite whose output paths point at the wrong checkout is baseline data, not verification.

**A worktree branched off `origin/staging` inherits `staging` as its upstream — create it with `--no-track`.** `git worktree add -b <feat> <path> origin/staging` sets `branch.<feat>.merge = refs/heads/staging`, so `git status` reads "ahead of origin/staging" and `<feat>` never appears on GitHub until pushed by name. A bare `git push` does **not** silently land on staging — `push.default=simple` (the git ≥2.0 default) refuses on the name mismatch — but its error offers **`git push origin HEAD:staging` as the first suggestion**, and nothing server-side stops that: the `protect-main-staging` ruleset carries only `deletion` + `non_fast_forward`, so an ordinary push to staging succeeds. Fix at creation — `git worktree add --no-track -b <feat> worktrees/<feat> origin/staging` leaves the upstream unset, so the first push must name the branch (`git push -u origin <feat>`) and sets the right one. Verify with `git config --get branch.<feat>.merge` (should be empty) before the first push.

**Recovering an accidental merge into `main`.** Opening a PR from a staging-based branch with `base=main` and squash-merging it dumps all of `staging` onto `main` as one giant commit. The guards are `staging`-as-default, `pr-base-guard.yml` (allowlists the head branch by NAME only — no merge-base check, so a staging-based `hotfix/*` still passes) and the `protect-main-staging` ruleset.

**Recovery is a revert, not a force-push.** The ruleset (id `20080050`, enforcement `active`, `bypass_actors: []`, `current_user_can_bypass: "never"`) carries `deletion` + `non_fast_forward` on `main`, so `git push --force-with-lease origin main` is rejected server-side with no way to bypass — do not reach for it mid-incident. Instead: confirm nothing is uniquely stranded on `main` (`git diff --stat origin/staging <bad-tip>`), tag the bad tip (`git tag backup-main-<date> <bad-tip> && git push origin <tag>`), then `git revert -m 1 <merge-sha>` (or `git revert <squash-sha>`) and push that forward. If a rewrite is genuinely required, the ruleset must be edited or temporarily disabled first — an admin action, taken deliberately. Either way releases are unaffected: `build-electron.yml` triggers on `v*` tags, never on a `main` push. (Note the repo is **public** — the old "private repo, free plan, so no protection" premise was wrong on both counts.)

**`main` is a release tag, not the shipped UI — baseline design work on `origin/staging`.** Features land on `staging` and reach `main` only at release, so reading `src/` in the main checkout can describe an app one or more releases old. A design proposal built that way looks internally consistent and is wrong: Account was recreated as three sections and Settings as five tiles when staging already had four and seven (v1.8.0 added the Activity Log, Network settings, per-space download folders, `ScreenRouter.tsx`). Before recreating any screen, run `git log --oneline main..origin/staging` and `git diff --stat main origin/staging -- src/renderer`; read the screens with `git show origin/staging:<path>` (or work in a staging-based worktree) and state the baseline commit/version in the artifact. The same applies to locale strings — new copy lands with the feature. Corollary: a "current state" claim in a mockup or review is a factual claim about a branch; name which one.

**Look before you overwrite.** Treat any overwrite/delete of a file you didn't create this session as a destructive merge decision: run the comparison (`wc`/mtime/`diff`) as its OWN command, read the result, then copy — never chain evidence-gathering `&&` overwrite (the overwrite runs regardless of the evidence). Plan docs under `~/Projects/Mirall/plans/` diverge in BOTH directions (plan authored in main, logs appended in worktree) — reconcile by appending, never whole-file copy. Recovery if clobbered: `~/.claude/file-history/<sessionId>/` snapshots + session transcripts (Write/Edit inputs, Bash heredocs), validated against an invariant (exact pre-loss line count).

## Testing tactics

Testing/a11y **discipline** — the layers, the change-type→coverage matrix, the a11y bar, and frontend scenario authoring (file-sizing, offline-edge, async-probe waits, split-text `sr-only`, timeout-vs-absent) — lives in `testing.md`. Dep-bump baseline-diffing lives in `dependency-updates.md`. Only debugging tactics that aren't reference material stay here:

**Never blanket-replace `console.log/warn/error` in a brittle test** — the runner emits its own TAP through them, so a blanket stub both miscounts (inflated by exactly the number of prior asserts) and swallows the failure diagnostic. Capture by discriminating on the code-under-test's own prefix/tag; forward everything else to the saved real console.

## Renderer ↔ worker wiring

**A new worker→renderer field must be added to the hook's EXPLICIT field-map.** Renderer hooks project field-by-field (not `{...e}`), so an optional field added only to the shared type + JSX type-checks and is silently dropped before the component. Trace the full path and patch every re-map: worker row object → IPC → hook's `ServerEntry` interface → hook's `.map()` projection → shared type → component. Grep the hook for the field after wiring (and confirm event-rebuild paths use `{...f}` spread). Invisible to typecheck/lint/backend tests; only test:fe catches it.

## Membership / replication convergence

**Separate admission from membership-display; gate admission on a fact replicated independently of the candidate.** A pending joiner's own `member/<S>` record isn't replicated to you until AFTER you admit them, so the admission gate must key off the APPROVAL (authored by an existing member you already replicate with), not the joiner's self-asserted membership or a fold over not-yet-replicated logs (reads empty). The derived fold owns the SET (list/removal), NOT the admission gate. When a "make X the single source of truth" refactor points a gate at X, check whether X is even observable when the gate runs.

**The admission gate must honor the approver's OWN approval.** `isApprovedByPeers` iterates OTHER members (self excluded), so an owner who approves a joiner whose record hasn't replicated yet drops them (fold-reconcile treats "unreadable" as "left"), then bounces them to pending on re-handshake. Add an explicit own-bee approval read. A fold-reconcile that can't read a member's record must NOT equate "unknown/null" with "positively left" — let the leave FRAME, not absence, drive removal.

**A membership exit needs a durable record AND a real-time signal.** `del member/S` is durable but not reliable real-time (the leaver may disconnect before it replicates; a lingering socket re-hits the admission gate as a fresh join-request). On the leave FRAME, tombstone the leaver (`markLeft`) so the fold subtracts them and the gate ignores their handshakes; lift only on genuine re-entry (`membership:request` → `clearLeft`), never on a stray handshake. General: when a disconnect races a state change, the tearing-down side can't propagate durably — the receiver records the intent the instant the reliable signal arrives.

**One notion of "is peer X online" — change every consumer at once.** When you move liveness from socket to lease, point display AND data-plane gates (download `isOwnerOnline`, transfer `isPeerConnected…`) at it together, or they decouple in exactly the silent-death edge case the lease was for. Keep the connection registry strictly for ROUTING (which socket to send/replicate over); every "worth attempting" precondition reads the single liveness truth; the send degrades gracefully (queues) if the socket is gone.

**When you delete a function, audit its piggybacked side effects.** A "prune"/"membership" helper can be load-bearing for an unrelated UI refresh (e.g. `emit('event:shares-updated')` on a peer profile-bee append). Grep the body for `emit`/`ipc` before deleting; diff removed emissions (`git diff | grep "emit('event:"`) against the renderer's `subscribe('event:…')` list — each removed emission must still fire from a surviving path. Data-polling flow tests won't catch it; only the frontend suite or an explicit event `waitFor` will. Membership/topology changes must fan a refresh out to EVERY dependent view (member/file/share lists), not just the one in mind.

## Debugging method (flakes & convergence)

**A subagent's read of library internals is a HYPOTHESIS — reproduce + instrument before designing a fix around it.** For a timing flake that "passes on a fast box," saturate every core with busy-loops and run the faithful load to make it deterministic, then dump per-peer state (core `length`/`contiguousLength`/`peers`, fold sets, follow/watch events) at the wedge. The decisive signal is often a plain invariant ("is the block on ANY peer?") no internals-reasoning surfaces. Validate causally: re-run the SAME saturation with the fix and confirm the rate goes to zero. (`bare-sidecar` does NOT propagate env vars into the worker — hardcode trace gating or pass via the bootstrap message, not `process.env`.)

**A flaky-under-load fix is only proven by a repro matching the failure's SHAPE.** Match the concurrency model (one test FILE at a time, not one subtest — subtests inherit prior subtests' residual teardown/GC), the CPU pressure (pin cores to the vCPU count; `MIRALL_TEST_TIMEOUT_SCALE` scales only TIMEOUTS, not worker speed — it is NOT a load model), and the duration (sustained contention, not short bursts). Establish the FAILING rate on the faithful repro first, then require a large clean run (0/20+) on that SAME repro before claiming a fix. The fastest repro is the one most likely too easy. Corollary: transitively serving an offline peer's core needs a COMPLETE local copy — a sparse record-read leaves gaps a contiguous follow can't fill (symptom: "peer attached, length known, zero blocks transferred").

**A first-success / re-attempt-hang asymmetry points at per-attempt STATE, not transport.** When attempt N passes and N+1 hangs on the SAME path, suspect leftover per-attempt state (a cached/persisted record like `downloads-meta`) before replication/timing — a transport bug would bite both. Before building a fix, REPRODUCE the actual failure mechanism, not just a plausible one; a repro that doesn't exercise the real call path validates the wrong hypothesis. If a shipped fix leaves CI IDENTICAL, the diagnosis was wrong — re-diagnose from the symptom, don't iterate on the same theory.

**Don't paper a convergence gap with a global periodic poll.** It adds steady load to EVERY instance (competing for the scarce CPU the failing test is starved of), can hold resources open past shutdown (timers, `findingPeers()`), and masks the real cause. Fix the targeted stall instead (hold a complete servable copy; send the grant BEFORE any bounded capture). If you must add a loop, prove it doesn't regress the suite on the faithful harness AND tears down cleanly (worker-shutdown test); prefer event-driven (hook an existing reliable signal) over time-driven.

## Data-layer / hypercore gotchas

**When opening a read-only hypercore/hyperbee by key, `await core.update({ wait: true })` (bounded) before reading** — `ready()` doesn't fetch the remote head, so the first by-key read starts at length 0 and returns empty (then self-heals via background replication). A `B.until`/`waitText` asserting only EVENTUAL visibility masks stale-first-read bugs; assert COMPLETENESS (peer count == owner count, multiple entries) and prefer a focused single-read test of the by-key path.

**Know who owns a Hyperdrive's corestore before closing it.** `new Hyperdrive(store, {_db})` / `new Hyperdrive(store)` is backed by `store` itself — `drive.close()` closes `store` (fatal if that's the ROOT: kills every other session → `SESSION_CLOSED: Cannot make sessions on a closing core`). Only `new Hyperdrive(store.namespace(x))` owns a private corestore safe to close; in identity mode release the drive's own cores (`blobs.core.close()` + `db.close()`) instead. Re-audit every `.close()` when the same teardown runs in two modes (one may have moved the object onto the root). Make destructive multi-step teardowns idempotent: delete the authoritative record FIRST so a mid-teardown failure degrades to leftover data, never an unremovable entry. When one sibling path carries a "we cannot call X here because…" comment, grep the others for the same call.

**Chunks handed to you by the transport must be COPIED before you stash them.** secret-stream decrypts in place inside udx receive-slab views, so a view you retain past the callback is overwritten by later traffic and silently corrupts the file — no error, just a bad hash at the end. `Buffer.from(data)` at the stash boundary; one memcpy buys correctness.

**A Corestore `keyPair` core's discoveryKey is the hash of its derived MANIFEST, not `crypto.discoveryKey(publicKey)`.** You therefore cannot recover a core's name from its public key after the fact — build the `discoveryKey → name` map on `ready()`. In-memory cores drop the alias entirely, which is why a corrupt core surfaces as an unnamed orphan in a store listing.

**On-disk marker strings are an API — the metadata-migration marker `.mir40-bees-v1` is FROZEN.** It is matched by exact string, so renaming it (even incidentally, via a logger tag or a label rename in a cleanup sweep) re-runs the entire migration for every existing user on next launch.

**"Which code path throws X" is a hypothesis — read the library's exact throw CONDITION and reproduce before a targeted fix/self-heal.** hypercore/corestore behavior changes entirely with call shape (by-key vs by-discoveryKey vs by-name): `STORAGE_EMPTY` fires ONLY for open-by-discovery-key with no key/manifest (replication machinery serving a zombie core), never open-by-key. A truncated async stack naming only low-level frames is NOT evidence of the high-level caller. When the on-disk corruption can't be fabricated reliably, test the GUARANTEE at a deterministic layer instead. Here the real fix was process-level: a Bare worker with no `Bare.on('uncaughtException'|'unhandledRejection')` handler turns any unhandled rejection into total death — install the backstop, tested directly under brittle-bare.

**A "not present" check that PRUNES its own record makes the state change one-way.** The downloads
claim (`downloads-meta`) is verified against disk on every listing, and every failing branch used to
`del` the row. Adding a second reason to report not-downloaded — the file sits outside the space's
current download folder — must NOT reuse that branch: pruning there would mean re-pointing the space
at the old folder can never restore the status, because the evidence is gone. Order the checks by
whether the claim is worthless (file deleted, upstream hash changed → prune) or merely out of scope
(→ report false, keep the row). Generally: before adding a condition to a predicate that has
side effects, check whether the new condition is *reversible* — if it is, it does not belong in the
destructive path.

**Scope a stored claim against the setting the user PROMISED, not against the effective value.**
`getDownloadDir(spaceId)` falls back to the global root, so "is this file inside the space's
download folder?" silently answered "no" for every space that never overrode it as soon as the
GLOBAL folder changed — un-downloading hundreds of untouched files and inviting a duplicate
re-fetch of each. The per-space override is a promise about one named folder; inheriting a default
is not a promise about anything, so only the override may narrow scope. Generally: when a value has
an explicit-vs-inherited form, ask which one a stored record was written against before comparing —
`getX() ?? getGlobalX()` is the wrong reader for a scope check even though it's the right one for
"where does the next write go".

**A cross-cutting invariant has to be enforced at EVERY entry point, or it isn't one.** "A download
root never overlaps a share" was checked when picking a download folder and when adding a *mirror* —
but not when adding an *owned* share, and not for the global download folder. Both gaps were
reachable by doing the same two operations in the other order, which is the normal way to hit them.
When adding a rule about two pieces of state, enumerate every path that can write EITHER one, and
make each rejection run before any side effect (a write probe inside a folder you're about to refuse
lands a file in a watched, published tree).

**`shared/core/paths.js` imports `bare-*`, so anything importing it becomes Bare-only.** Adding an
import of it to `shared/spaces/space.js` dragged `bare-os` into four `test/unit` files that are
Node-runnable precisely because that chain is bare-free (`require.addon is not a function` at
import time, before any test runs). The bare-free rule `path-keys.js` documents in its header is a
real, load-bearing layering constraint — pure string math goes in `path-keys.js`, and lifecycle
hooks that need a `bare-*` module belong in the worker, which is Bare-only anyway.

**Never `core.clear()` a block range of a Hyperbee to reclaim deleted rows — it corrupts the live
tree.** Every append writes one block holding `{key, value, index}`, so blocks are simultaneously
data *and* B-tree index, and old blocks stay referenced by the current root long after their keys
are deleted. The tell: a fresh reopen (not the warm handle — the node cache masks it) reads back 0
rows and stalls on a non-local block. `del` is an append too, so pruning a Hyperbee always *costs*
disk and never frees it. To reset a bee wholesale use `core.truncate(0)` + `compactRange` (a
`clear()` after the truncate is a no-op — hypercore early-returns once `start >= length`) — **not**
`clearAndPurgeCore`: deleting a core's storage and reopening it under
the same (derived, deterministic) key hands back corestore's cached tracker entry, which reports
the old length over storage that is gone, so every later read hangs. Truncation keeps the handle
valid and needs no alias surgery. Order matters too — clearing a bee's blocks *before* closing it
wedges `bee.close()`, since the close path reads blocks that are no longer local.

**Size a store problem only after `compactRange` — raw directory size is mostly write
amplification.** A bee measuring 25 MB on disk fell to 4.4 MB from RocksDB compaction alone and to
1.1 MB after a full clear + compaction, so an uncompacted `du` overstated the reclaimable residue
by ~6x. Compact first, then measure, or you optimize transient SST/WAL churn instead of the real
retained bytes.

**A factory invoked during a circular import must not read its own module's `const`s in its body.** `overlay-download.js` and `overlay-backend.js` import each other directly, and BOTH `overlay-backend.js` and `loose-overlay.js` construct a download engine at module top level — so the hoisted `createOverlayDownloadEngine` runs while `overlay-download.js` is still evaluating and every `const` in that file is in its temporal dead zone. The tell is `ReferenceError: Cannot access 'X' before initialization` naming a constant declared plainly ABOVE the function — existing code escapes it by only touching those constants from methods called later. Read config constants inside the method that uses them, or a new option default added for testability wedges the worker at boot.

## Stopping long-running work

**Stopping a periodic loop must cancel the in-flight pass, not just the timer.** Clearing `setInterval`/pending timers leaves a materialize/download pass already iterating thousands of files running to completion — and its trailing persist can RESURRECT the just-torn-down state. Use a per-key generation counter checked between items (bail if it changed), abort the active stream/transfer (track it in a map the stop path can `destroy()`), and guard the trailing persist. Test with enough files/bytes that the pass is genuinely in flight at stop time; assert both "progress halts" AND "state not resurrected."

## Adding a parallel implementation

**When you add a parallel implementation behind a mode flag, audit it branch-by-branch against the original as the reference** — especially status/labelling, path resolution, deletion semantics, and counts. Enumerate the divergence surface (grep the flag) and check each handler; confirm the branches WITHOUT a mode split are genuinely mode-agnostic. The systematic guard is a conformance suite running the same assertions against both modes across the FULL state matrix (browse/download/mirror/preparing/owner-offline), not just the happy path. This recurs concretely for loose-file vs folder shares — both move bytes through the overlay backend, so an overlay fix landed on one path is a standing gap on the other; grep the sibling path in the same change.

## Platform quirks

**Preallocating a partial file with `ftruncate` is free on APFS/ext4 and expensive on NTFS.** POSIX filesystems make it sparse; NTFS reserves real clusters, so a download of a file larger than free space fails ENOSPC at *preallocation* — before a single byte transfers — rather than at the last block. Preflight with `statfsSync`, classify the error code, and pause rather than retry (a retry loop on a full disk never converges).

**Re-showing a hidden macOS window makes Chromium focus the first tabbable element.** A skip-link therefore appears to self-activate on window restore ("phantom tab traversal"). Guard on real tab intent — a Tab keydown immediately preceding the focus — and blur otherwise. Reproduce ONLY via a genuine tray/status-item menu click; `open -a` takes a different activation path and hides the bug.

**A packaged GUI app's argv is written by the OS, so a strict CLI parse at module top is a crash waiting to happen.** Windows and Linux hand a clicked `mirall://join/<code>` deep link to the process as a bare positional (macOS uses the `open-url` event instead), and paparam is strict by default — the URL bailed `UNKNOWN_ARG` while `main.js` was still evaluating, which surfaces as Electron's "A JavaScript error occurred in the main process" dialog: no window, no deep-link dispatch, and no `second-instance` handoff either, because the second process dies before `requestSingleInstanceLock` ever runs. It reads to the user as "the invite link is broken" while the bare code pasted into the UI works fine. Split OS-supplied positionals out *before* parsing and downgrade any remaining bail to a warning — a surprising argv may cost a flag, never the app. Declaring one offender at a time (`--no-sandbox`, for Linux AppRun) only patches the case you already hit.

**A deep link that round-trips through a browser or chat client can come back with a trailing slash.** `mirall://join/<code>/` failed while the bare `<code>` worked, because the extractor stripped only LEADING slashes and the survivor failed base64url validation. Neither hex nor base64url contains `/`, so strip both ends. The extractor exists in three hand-mirrored copies (`src/main/deeplink.js`, `src/shared/invite-envelope.js`, `src/renderer/invite-envelope.ts`) — a fix to one is a standing bug in the other two; only the first two have test coverage.

## Security / metadata

**Gate member-only operations by capability at the worker boundary, not the UI** (treat UI hiding as cosmetic defense-in-depth). When reasoning about "can a non-member do X," name the exact capability each op leaks: read access is gated cryptographically (the SCK — usually already holds, so often NO escalation); the residual risk is the LESSER capability the op still exposes (e.g. the topic/discovery key → an outsider can connect and spam join-requests). Decide if leaking that is acceptable and hard-refuse at the data layer if not — don't stop at "the crypto gate holds, so it's fine."

**Enforce path containment read-side, independently of Hyperdrive.** A malicious peer appends raw Hyperbee entries directly, bypassing Hyperdrive's write-side path normalization, so a traversal path arrives already stored and looks legitimate on read. Resolve each path against the destination root before writing it out — and note a bare `startsWith(root)` is not a boundary (`/root-evil` passes it); compare on a separator-terminated prefix or use `path.relative`.

**A `profileKey` is a Hypercore MANIFEST hash, not an ed25519 public key** — signature verification against it directly always fails. Rebuild the manifest from the claimed `signerKey` + `signerNs` and check that it hashes to the `profileKey`. Corollary: an unauthenticated `membership:request` naming someone else's `profileKey` must never be answered with the SCK.

**Before calling plaintext replicated state a "leak," classify each field.** (a) Needed BEFORE the gating key exists (identity used to negotiate membership) → necessarily public, working as intended; (b) a key/pointer whose target is encrypted → safe by the plaintext-key→encrypted-data invariant; (c) actual sensitive DATA not required pre-membership → the genuine residual (the only bug). Never propose "just encrypt the bee" without checking key granularity: one identity spanning N spaces with N distinct SCKs has no single key — the fix is a per-scope encrypted projection or relocating the data into the correctly-keyed store.

## Network / streams

**Never destroy a peer's socket to "heal" a wedged hypercore replication session.** That socket is the single Noise mux carrying every core, transfer, and control channel for that peer, so the "recovery" is itself the outage. A wedged session starves even explicit `core.get()` calls (it is per-core, not per-request) — recover by capturing what you need through an explicit get with a bounded timeout, falling back to `bee.checkout(core.contiguousLength)` when the peer is offline.

**Injecting latency into a reliable stream must preserve FIFO order.** Per-frame independent `setTimeout`s with jitter let a later frame overtake an earlier one, corrupting a stream whose consumers (Protomux framing, hypercore replication proofs) assume strict order — real links shape BELOW the reliable layer (udx reassembles in order), so app-level shaping must keep order. Release frames through a single FIFO queue with monotonic release times: `at = max(now + latency + rand(jitter), prevFrameAt)`. Don't wrap the socket in a fresh Duplex (the Noise stream carries load-bearing `.remotePublicKey`/handshake hash that Protomux reads) — override `.write` in place. Proof: an impaired transfer still lands byte-exact AND is measurably slower.

**Piping a test run into `tail` throws away its exit code, and its failures.** `npm test 2>&1 | tail -8` reports the exit status of `tail` (always 0), and an 8-line window shows a crash's stack trace while hiding the summary — so a suite that aborted reads as "exit code 0" with nothing obviously wrong. It also truncates the TAP `not ok` lines that say WHAT failed. Redirect to a file and check `$?` (`npm test > /tmp/run.log 2>&1; echo $?`), then grep the file for `^not ok`. A green claim built on a piped tail is not evidence.

## Release / build

**Prerelease channels (beta/dev/staging) use single-drive `pear stage` + `pear release`** (`upgrade-keys.json` entry is a STRING). `pear provision` rejects prerelease SemVers, but the OTA updater compares by SemVer precedence, so prerelease builds must carry monotonically increasing `-beta.<run>` versions. Only prod (clean `X.Y.Z`, bumped per release) uses the `{stage, provision}` object. `pear touch` the seed drive ON the seed VM or `pear stage` fails `SESSION_NOT_WRITABLE`.

**macOS CI codesign `Sealed Resources=none` / `Signature=adhoc` is a transient flake.** Re-run the macOS job; don't chase forge.config.js / keychain / secrets. It's a resource-sealing race.

**`UPGRADE_KEY_PROD` must equal the seed VM's `production.provision` key, and rotating one means rebuilding.** The key is baked into the client at build time, so re-keying the provision drive without shipping a new build strands every installed client — they keep polling a drive nobody seeds. Rotate both together, then release.

**`signtool`'s Windows SDK version must match the runner OS's AppxSip build.** A mismatched SDK signs a package that verifies on the signing host and fails at install on user machines. Pin the SDK to the OS image, and re-pin when the runner image bumps.

**An absent macOS notarization secret silently disabled notarization instead of failing.** `osxNotarize` was gated on `APPLE_ID` + `APPLE_ID_PASSWORD` + `APPLE_TEAM_ID` all being present (packager rejects a partial credential set), so a single unset var — `APPLE_TEAM_ID`, never created — left the gate shut with no warning: builds went green and shipped signed-but-unnotarized DMGs that Gatekeeper blocks at first launch. Signing and notarization are separate gates; a "successful" macOS build proves only the first. `forge.config.js` now fails a signed darwin build with incomplete notarization credentials (opt out locally with `ALLOW_UNNOTARIZED=1`). Generalize: any capability gated on `if (all creds present)` needs an else-branch that shouts, or its absence becomes invisible.

**To date-bound a CI credential break, read the secrets' `created_at` vs `updated_at`, not just the run history.** `gh api repos/OWNER/REPO/actions/secrets` gives both. A secret whose `created_at` sits between the last green run and the first red one is the change — and a `created_at` equal to `updated_at` means it was *added*, never rotated, so the feature it gates has never actually run and no earlier green build is a baseline to restore. Secret VALUES are masked in logs (a `security find-identity` line printing `"***"` means the identity matched a secret exactly), so timestamps are often the only forensic signal available.

**Quantify packaging/size deltas against a CI-equivalent build, not local `out/`.** A subproject's gitignored `node_modules` on your disk (e.g. `cloudflare-worker/`) is NOT in the shipped artifact — CI's `npm install` only installs the main project. `git ls-files` the dir + check the workflow's install steps before projecting a win. Native prebuilds ship pre-stripped (symbol stripping ≈ 0).
