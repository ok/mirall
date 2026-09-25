# Lessons

Cross-cutting debugging tactics and system gotchas. Read at session start.

**Style for every lesson:** a **bold imperative claim**, then 1–4 sentences with only the mechanism
(why it bites), the tell (the signal that points at it) and the fix (API, formula or sequence). No
dates, incident stories, counts or PR numbers. Merge into an existing lesson rather than adding a
near-duplicate. A rule that belongs to one discipline goes in its doc instead: testing/a11y/scenario
authoring → `testing.md`; visual language → `design.md`; dependency bumps → `dependency-updates.md`;
architecture → `solution-architecture.md`; coding standard → `coding.md`; workflow → `AGENTS.md`.

## Workflow & git

**Plan approval ≠ build approval.** Approving a plan, answering its open questions or refining part
of it is still planning. Start code only on an explicit build signal ("go implement"); when unsure,
ask "start implementing, or keep refining?".

**Base a stacked worktree on the active feature branch, not `main`, when the fix depends on
in-flight work.** Re-verify file/line references in the actual target tree if a subagent explored a
different checkout. Before the first push, `git config --get branch.<feat>.merge` must be empty.

**Session cwd persists across Bash calls — prefix every repo command with `cd <checkout> &&`.** A
one-off `cd` elsewhere silently redirects later relative-path commands, and a wrong-checkout run
succeeds convincingly. Evidence and log paths must contain the `worktrees/` segment.

**Rebase onto `origin/main` immediately before the local run you report.** CI tests the merge: a
test added by a PR that landed after your branch was cut cannot fail locally. The targeted set after
a rebase is "what the incoming commits added", not "what my change touched". Tell: a `test:bare`
file you've never seen dying with exit 134 while your run was green.

**Rebase and `npm install` are one step in a worktree.** A dependency added on main is missing
from an older worktree's `node_modules`. Tell: a test file at 0/0 passed, exit 1 (it died at load).

**A `release/x.y` branch is the last release; baseline design and "current state" claims on
`origin/main`.** Read screens and locale strings with `git show origin/main:<path>` (or a main-based
worktree), and name the baseline commit in the artifact.

**Look before you overwrite.** Run the comparison (`wc`/mtime/`diff`) as its own command and read it
before copying — never chain evidence `&&` overwrite. Plan docs under `~/Projects/Mirall/plans/`
diverge in both directions; reconcile by appending. Recovery: `~/.claude/file-history/<sessionId>/`
plus session transcripts.

**`git checkout -- <path>` restores from the index, not the last edit.** With nothing staged it
discards every unstaged change in the file. To undo a temporary mutation, copy the file aside first
and copy it back.

**Recover an accidental merge into `main` or a `release/*` branch with a revert, never a
force-push.** The `protect-main-release` ruleset blocks non-fast-forward with no bypass. Check
nothing is stranded (`git diff --stat <last-good> <bad-tip>`), tag the bad tip, then
`git revert -m 1 <merge>` and push forward. Releases trigger on `v*` tags, not on a branch push.

**Verify CI by head SHA, never by PR.** After a force-push, `gh pr checks` shows the previous head's
completed run as current, and a head with zero runs has zero pending rows. Require zero
non-completed runs and the expected run count. Every merge to `main` invalidates the verification
of every other open PR.

```
H=$(gh pr view <N> --json headRefOid -q .headRefOid)
gh api repos/<o>/<r>/commits/$H/check-runs \
  --jq '.check_runs[]|"\(.name)=\(.status)/\(.conclusion)"'
```

**Retarget the upper PR of a stack before merging the lower one.** `gh pr merge --delete-branch`
closes any PR based on the deleted branch, unrecoverably. `gh pr edit <upper> --base main` first.

**Verify an issue's claims against the tree before implementing it.** Counts, "still to do" items
and named symbols in a task description are often wrong in both directions; the first pass is
verification, and expect the scope to shrink.

**Quantify what the broken thing was worth before rating a bug's severity.** A dead feature whose
remaining payload is megabytes is not a gigabyte loss; reviewers price the fix off that sentence.

**A user-facing visual change is pushed only after the user has run it locally.** Geometry harnesses
prove alignment, not appearance; green tests are the precondition for asking.

**Never launch `npm run test:fe` unprompted.** It takes over the machine's foreground and AX API for
minutes. Propose the scenarios and let the user start them; the automated gates need no permission.

## Tests that pass for the wrong reason

**A test that cannot fail is worse than none — when a red-first test goes green too easily, print
what it observed.** Assert the fixture reached the guarded path (a side effect, a call count) before
asserting the bound; a moved data path filters the old fixture out before the code under test runs.

**A green suite proves the mode it ran in, not the mode you ship.** When a subsystem forks on a mode
(identity vs seed, master secret present or not), check which mode the harness boots before trusting
any test. Destructive paths (leave, purge, reclaim, shutdown) must run in the production mode.

**A test double must model the transaction boundary the test is about.** If the scenario is a window
between staged → in flight → landed, the fake needs that window too (puts land only on `flush()`),
or the red-first proof proves nothing. A fixture round-tripped through a bee loses subclassing —
JSON hands back a plain array.

**A source-scanning guard goes vacuous when you rename what it matches.** Before pushing a rename,
signature change or hoist, grep all of `test/` (integration too) for the old spelling and run every
file that `readFileSync`s a touched source. When a guard slices source by markers, assert
`indexOf >= 0` first — `slice(start, -1)` silently becomes "to end of file". Prefer a positive
property over an absence.

**Pin a value through the production read path, never through the file's text.** A regex over `src/`
fails on a refactor and passes on a regression (a wrong default still matches `\d+`). Source scans
are for structural facts only (an import edge, a statement order).

**Moving an emitter behind a shared module moves a test seam.** Tests that re-wire a module's ipc
(`initX(wrappedIpc)`) stop seeing frames that now leave through the shared reporter. Grep for the
`init*(` seam of every module that lost an emit and re-wire the reporter
(`test/helpers/overlay-ipc.js`).

**Integration tests cannot fake an offline remote owner.** A fabricated ownerKey makes the share
read return null and the pass exit before any gate — the test passes with the gate deleted. Assert
offline-owner behaviour at the flow layer. Likewise a mirror re-fetching its own deleted file is
served from the local overlay spool; "offline owner" needs a mount created after the owner left,
against content this peer never held.

**A two-peer loopback flow never reaches "relayed, then punched through".** The punch lands before
the relay carries a byte. For behaviour that needs a live relayed stream, drive `blind-relay`
directly in an integration test and assert on `relay.stats`; print it once before trusting a red.

**An integration test that stubs a call to throw proves the wiring, never the premise.** Drive at
least one case of a fault class with the real condition (a real `chmod 000` file).

**A layout harness that errors before its assertions is absent, not failing.** Reproduce on a
detached checkout of the base (`git worktree add --detach <tmp> HEAD`, symlink `node_modules`)
before reading the diff. A harness mounting a real dialog needs the app's providers (`ToastProvider`
at minimum) — a missing one renders nothing rather than erroring. `--no-build` reuses stale
`dist/harness-*.js`; `npm run build` does not rebuild them.

**`npm run test:layout:a b c` runs only `a`, and `test:fe s1 s2` only `s1`.** Extra names become
arguments to the first runner. One command per harness.

**A local flow "green" is trustworthy only up to the first throw.** A timed-out `until()` escapes,
brittle records no `not ok`, and the count still looks near-perfect. Compare planned against
executed.

**Piping a test run into `tail` discards its exit code and its `not ok` lines.** Redirect to a file,
check `$?`, grep `^not ok`. Filter gate output case-insensitively (`ERROR:` is uppercase in
`check-test-timing.sh`).

## Testing tactics

**Measure a resource delta from the module's own accounting, never whole-process.**
`brittle-bare -j` is threads in one process: fd and memory deltas measure the neighbours as much as
the subject.

**`launchPeer` on a relaunch sends every handshake twice and doubles the announce backoff.** Its
`profile:set` re-broadcasts on top of `onopen`: a relaunched exchange is `2K + 8` frames and the
first ledger retry is 20 s out. Budget flow timings accordingly.

**A test of platform-conditional behaviour must pin `process.platform`.** CI is Linux, dev is macOS;
`looksLikeNetworkPath` is platform-scoped. Use `withPlatform(name, fn)`
(`test/helpers/with-platform.js`), or the UNC form when the test is about something else, and
compare assert counts across platforms.

**Never blanket-stub `console.*` in a brittle test.** The runner emits TAP through it. Capture by
the code-under-test's own prefix and forward everything else.

**Adding a required member to an injected `deps` bundle breaks every test double.** If it's an
internal helper (memo, cache, formatter) rather than a substitutable collaborator, call it directly
and assert its effect through a dep already injected.

**A change to what a request admits is a change to every flow test that issues it.** `grep -l` the
flow tier for the request name and check each hit for the state the new rule refuses; re-sequence
the test rather than loosen the rule.

## Static gates and what they miss

**`npm run build` does not run CI's lint step.** Before pushing, also run
`check-comment-hygiene.sh`, `check-test-timing.sh` and `check-release-mime.sh`.

**Targeted test runs are blind to repo-wide guards.** Adding or moving a file needs the guard family
once (the `.claude/` doc path check, i18n scans, `renderer-contract-only-imports`,
`no-hand-mirrored-vocabularies`).

**A module split is only proven by something that runs it.** `tsc` skips the worker and `no-undef`
resolves a dropped import whose name is a global (`fetch`, `performance`, `URL`) to the environment.
`crypto` is `'off'` in the eslint globals; the rest are not. After moving worker handlers, run one
flow test that exercises them.

**Nothing in CI runs the Electron main process.** After any change to `src/main`, boot it once:
`npx electron . --storage=<tmpdir>`, wait ~15 s, assert it's alive and the log has no
`threw`/`Error`. It catches module-load order: a `const x = require()` below its call site (TDZ),
and a module-scope `require()` of the ESM contract during main's own CJS load
(`ERR_REQUIRE_ESM_RACE_CONDITION` — require lazily inside the function).

**A monkeypatch misses modules that destructure the export at load.** `bare-sidecar` captures
`child_process.spawn` at require time, so the asar spawn patch must be main's first statement
(pinned by `test/unit/asar-spawn.test.js`). Ask "who captures this export at load?" whenever a
refactor moves a require; only a packaged install exercises asar paths.

**Never retype a persisted constant during a move — export it from the new module and import it.** A
retyped key prefix (`'file:'` for `'file/'`) re-addresses every replicated row and passes every
static gate. Mark persisted/on-wire constants at their definition.

**A path codemod must try `.js`, `.ts` and `.tsx` before declaring a specifier broken.** A basename
repair pass will rewire renderer `./ipc.js` (really `ipc.ts`) to the worker's `ipc.js` — the
runtimes share basenames by design. Exclude by full path; run the codemod before `git mv` or follow
it with a repair pass; run `eslint` afterwards (the contract-only import rule catches a crossed
boundary, `tsc` doesn't). Then diff each importer's names against the module's actual exports and
import each repointed module first in a fresh Bare process (the `import-time.test.js` recipe).

**A typed handler is not an exact one.** TypeScript runs no excess-property check on an inferred
return, so `ack-responses.test.js` still earns its place. Widening `tsc` to the worker is opt-in via
`// @ts-check`; fix inferred widening with JSDoc on the callee, never a cast at the call.
Mutation-test a new compile-time guard before trusting it.

**Size a backstop assertion between the two outcomes it distinguishes, not just above today's
value.** A bundle-size guard 200 bytes above the real bundle gates unrelated work.

## Debugging method

**A subagent's reading of library internals is a hypothesis.** Reproduce and instrument before
designing a fix; the decisive signal is often a plain invariant ("is the block on any peer?").
`bare-sidecar` does not propagate env vars into the worker — pass trace switches via the bootstrap
message.

**Read the library's exact throw condition before a targeted fix.** hypercore behaviour depends on
call shape: `STORAGE_EMPTY` fires only for open-by-discovery-key with no key/manifest. A truncated
async stack is not evidence of the high-level caller.

**A flaky-under-load fix is proven only by a repro matching the failure's shape.** One test file at
a time, cores pinned to the CI vCPU count, sustained contention. `MIRALL_TEST_TIMEOUT_SCALE` scales
timeouts, not worker speed. Establish the failing rate first, then require 0/20+ on the same repro.

**"Saw 0 events" with clean logs means the event fired before the listener existed.** Tell: a
one-shot edge awaited right after a relaunch, bimodal pass-fast/fail-to-deadline. Saturate every
core and timestamp both workers' stdout against the harness steps. Fix the harness's memory (the
boot backlog in `launchPeer`), never the deadline.

**A derived cache lags its author's own write.** A gate reading a debounced fold can lose a race
against the very peer the write was about, and an LWW receipt can make it permanent. Apply a local
write to the live entry in the same step as the durable write, and let the fold confirm. Reproduce
by widening `deriveDebounceMs` on the folding peer.

**First attempt passes and the next hangs on the same path → suspect per-attempt state, not
transport.** A persisted record (e.g. `downloads-meta`) left from attempt N. If a shipped fix leaves
CI identical, the diagnosis was wrong.

**Don't paper a convergence gap with a global periodic poll.** It loads every instance, can outlive
shutdown, and masks the cause. Fix the targeted stall; prefer hooking an existing reliable signal.

**A `package-lock.json`-only PR that turns a tier red with zero `not ok` and 100% timeouts is a
transport dependency moving.** Diff the lock by resolved version, not the patch; details in
`dependency-updates.md`.

## Renderer

**A status token names an actor's activity, not a file's condition.** One token for "I am hashing"
and "I am waiting on the owner's hash" makes both sides wear one pill. Tell: a `status → badge` map
that ignores the `isOwn` flag the caller passes. Fix in `contract/statuses.js`, follow the token
through every projection, and assert the derivation in a pure module.

**A new worker→renderer field must be added to the hook's explicit field map.** Hooks project
field-by-field, so a field added only to the type is dropped silently. Trace worker row → IPC → hook
interface → hook `.map()` → shared type → component.

**Gate an empty state on all of its async sources having settled.** A failed read is unknown, not
empty. Give sibling list hooks the same cross-mount cache plus `prune<X>(liveIds)` from `useSpaces`;
never let an event-driven `refresh()` flip `loading` back on. Extract the gate as a pure predicate.

**`useQuery`'s `loading` means "a read is in flight" and re-raises on every refetch.** A boot or
route gate asks "has an answer ever landed" (`data !== undefined || error !== null`), via a pure
projection that never sees `loading` (`model/profile-gate.js`). Gating a tree on it remounts in a
loop that every non-frontend test misses.

**A subscription that writes shared state is installed once, next to the store, never in a hook.**
In a hook it writes once per mounted consumer, defeating the store's identity check.
`installPushBridges` in `store/reconcile.ts`; new writers are justified in the `STORE_WRITERS`
allowlist.

**A screen prop can change without a remount.** `ScreenRouter` renders without a `key`, so switching
spaces reuses the same instance and a `useState` initializer keeps the old entity. Adjust state
during render (`if (prev !== id) { setPrev(id); setValue(read(id)) }`), not in an effect.

**A boot-time config snapshot must be written through.** `config-client.ts` caches `config.json`
once; a setter that persists over its own IPC without mutating the cache reverts on remount. Every
`getXPref` has a `setXPref` that mutates the cache first.

**A focus ring is painted outside the border box, so every clipper eats it.** An `overflow-y-auto`
pane clips both axes. Fix with room — padding cancelled by an equal negative margin — and when
removing `overflow-hidden` from a flex/grid item, add `min-w-0`/`min-h-0`. Pinned by
`test:layout:focusring`.

**A sticky header pins at the scrollport top plus the container's `padding-top`.** Give a pane with
a sticky header no `pt-*`; keep ring room horizontal. Guard in `test/frontend-layout`.

**A `dark:` base and a `hover:` state have equal specificity, so source order decides.** Use a
theme-flipping token (`surface-control`) on anything with interactive states, not a `dark:` variant.

**Re-showing a hidden macOS window focuses the first tabbable element.** A skip-link appears on
restore; guard on a Tab keydown immediately preceding the focus. Reproduce only via a real tray menu
click (`open -a` takes another path).

**An empty state answers the user's live question, not the product's best feature.** Lead with the
constraint that contradicts what users bring from elsewhere; keep a differentiator only in its
consequential form.

## Frontend harness (agent-desktop)

**`test/frontend/preflight.mjs` pins the agent-desktop minor floor.** On 0.8: refs are
snapshot-qualified (`@<snapshot_id>:eN`); `list-windows` includes invisible Electron helpers (filter
on `visible`); `wait --text` matches `name` only while static text lives in `value`; a press with no
AX action is `POLICY_DENIED` (opt into `--headed` per element); a leftover pre-0.5 refmap in
`~/.agent-desktop` makes `status` fail with `INVALID_ARGS` until pruned.

**A menu trigger is not a `button` in the AX tree.** react-aria's `aria-haspopup` makes it a pop-up
button (`role: "combobox"`). Match menu triggers by name only.

**A `<label for>` shadows the field it labels.** The label gets its own ref carrying the field's
name and precedes it. Read values with `findNode(..., { actionable: true })`.

## Membership & replication

**Gate admission on a fact replicated independently of the candidate.** A joiner's own `member/<S>`
record isn't replicated until after admission, so key the gate off the approval authored by an
existing member. The fold owns the set, not the gate. Include the approver's own approval
(`isApprovedByPeers` skips self).

**Unknown is not "left".** A fold that can't read a member's record must not remove them; let the
leave frame drive removal. On the leave frame, tombstone (`markLeft`) and lift only on genuine
re-entry (`membership:request` → `clearLeft`).

**One notion of "is peer X online" — change every consumer at once.** Display and data-plane gates
read the single liveness truth; the connection registry is for routing only.

**`isOwnerOnline` is false for our own key.** Presence tracks remote peers only, so a gate on
`isOwnerOnline(mount.ownerKey)` freezes every self-mirror. Use the pure predicate in
`mirror-policy.js`.

**When deleting a function, audit its piggybacked side effects.** Grep the body for `emit`/`ipc` and
check each removed `event:*` still fires from a surviving path; polling flow tests won't notice.

## Data layer & hypercore

**Two Corestores on one path conflict inside one process.** The lock is per open file description
and released asynchronously. Open through `openStore()` (`core/store.js`), which retries; never let
boot continue past a failed `ready()`.

**A `get → spread → put` on a bee loses the interleaved writer's field.** Serialize per key
(`createRecordWriter`, `core/bee-writer.js`) and keep `cas` as the assertion.

**Whatever writes through a buffer must read through it too.** A fast path that reads the bee while
writes are staged in a batch sees "not done" and redoes the work.

**A `.catch(() => {})` on a write that encodes status is a future re-drive.** Await it, warn with
key and code, and say in a comment who finishes the intent. `debug` is not surfacing — the default
level is `warn`.

**Open a read-only core by key, then `await core.update({ wait: true })` (bounded) before reading.**
`ready()` doesn't fetch the remote head, so the first read is empty. Assert completeness, not
eventual visibility.

**Know who owns a Hyperdrive's corestore before closing it.** `new Hyperdrive(store)` closes `store`
on `drive.close()` — fatal for the root. Delete the authoritative record first so a failed teardown
leaves data, never an unremovable entry.

**A Hyperbee whose Corestore closed underneath it still reports `closed === false`.** Only
`handle.core.closed` is true. Handles are owned by a resource that closes them, never probed by a
cache.

**A cache of live handles needs refcounts for readers too.** Anything holding a handle across an
await must pin it, or an LRU `onEvict` closes it mid-read.

**Never `core.clear()` a Hyperbee's blocks to reclaim deleted rows.** Blocks are data and B-tree
index at once. Reset wholesale with `core.truncate(0)` + `compactRange`, not `clearAndPurgeCore`
(the cached tracker reports the old length and reads hang). Close the bee before clearing. Measure
store size only after `compactRange`.

**Copy transport chunks before stashing them.** secret-stream decrypts in place in udx receive
slabs. `Buffer.from(data)` at the stash boundary.

**A keyPair core's discoveryKey hashes its manifest, not its public key.** Build the
`discoveryKey → name` map on `ready()`.

**On-disk marker strings are an API.** `.mir40-bees-v1` is matched exactly; renaming it re-runs the
migration for every user.

**A factory invoked during a circular import must not read its module's `const`s in its body.**
Tell: `Cannot access 'X' before initialization` naming a constant declared above. Construct nothing
at module level; `boot.js` is the composition root and `test/integration/import-time.test.js`
imports each cycle member first.

**Moving an init into a `Subsystem._open` reorders it, and null-guards that return instead of
throwing fail silently.** Diff its new position against `origin/main` and check every
collaborator it reaches. Restart/crash flow tests are the only layer that catches this. Pass
collaborators as constructor deps, not nullable `hook?.()` slots.

**An `await` on an unref'd timer with no other handle deadlocks under Bare.** The loop empties and
`beforeexit` fires. A wait on the close path must be ref'd.

**Importing `shared/core/paths.js` (or anything `bare-*`) makes a module Bare-only.** Pure string
math lives in `path-keys.js`; the pure modules are listed as `pureSpacesModules` in
`eslint-rules/invariants.mjs`.

**A `bare -e "require('x')"` from the repo root proves nothing.** A transitive devDependency answers
it. Confirm with `npm ls` and probe from outside the repo.

**A parse guard is not a shape guard.** `JSON.parse('null')` succeeds and the next property read
throws into protomux, destroying the socket. After parsing untrusted input, assert
`!!v && typeof v === 'object' && !Array.isArray(v)`.

## Destructive and long-running work

**A "not present" check that prunes its own record makes the state one-way.** Prune only when the
claim is worthless (file deleted, hash changed); a reversible condition (out of scope) reports false
and keeps the row.

**Scope a stored claim against the setting the user promised, not the effective value.** A fallback
reader (`getX() ?? getGlobalX()`) is right for "where does the next write go" and wrong for a scope
check.

**A cross-cutting invariant must be enforced at every entry point that writes either side.** Reject
before any side effect.

**A destructive diff must re-derive its precondition at the moment it acts.** A snapshot taken
before minutes of hashing is stale. Re-resolve the mount, refuse when the root is missing (a
vanished root looks like every file deleted), then re-stat.

**A destructive action's confirmation must be at least as strict as the check that proposed it.**
`statSync` case-folds and follows links where readdir names are byte-exact. Stat first, then confirm
the leaf byte-for-byte in its parent's listing (`disk-presence.js`). The same case-folding makes a
readdir set the wrong substitute for `existsSync`.

**If "in progress" isn't a representable state, work gets done twice.** Give the work an identity
and a state (a queue); keep the old API's contract (resolve after the work, return totals).

**Admission and enqueue are one step.** Enqueue inside the lock, await outside it.

**A cancel that settles a waiter must mark it cancelled.** The consumer checks the marker before
acting, and a cancelled running item stays the path's live item until its executor returns. Anything
that resolves a caller on cancel waits for the tail (`whenPathIdle`) or says the effect is still in
flight; teardown waits for running executors, not just the queue.

**Emit only when state actually changed.** A notifier that fires on a no-op loops with a listener
that answers with the action. Pin the no-op path with an assertion that it emits nothing.

**Stopping a periodic loop must cancel the in-flight pass, not just the timer.** Use a per-key
generation checked between items, abort the active stream, and guard the trailing persist. Assert
both "progress halts" and "state not resurrected".

**A recovery budget that resets on "it booted" doesn't bound a process that exits by choice.** Two
failure modes sharing one exit need two budgets and a distinguishing exit code
(`WORKER_EXIT_UNSTABLE`). Escalation is disarmed until boot completes, and the disarm must not
latch.

**Kill a wedged worker with `worker._process.kill('SIGKILL')`.** The sidecar Duplex has no `kill()`,
and a starved loop can't service SIGTERM. Back it with `process.on('exit')`.

**Two non-atomic writes: order them so a crash leaves the visible failure.** For secret-at-rest plus
a record naming it: config first when adding, vault first when removing, `flush()` rather than
trusting the debounce, and never `catch {}` the delete.

**A level-triggered probe only sees an edge somebody recorded.** Whoever notices a state first
records it where the probe reads (`handleOwnedMountGone`), and the probe reconciles its baseline
against the durable record each tick (`mount.status === MOUNT_POINT_GONE ? false : lastSeen`) while
keeping its early `continue`.

**When a parallel implementation sits behind a mode flag, audit it branch by branch against the
original.** Grep the flag; loose-file and folder shares share the overlay, so a fix on one path is a
gap on the other until the sibling is grepped.

**The worker respawn is the restart primitive.** For a change that can't apply live,
`request('shutdown')` and let `scheduleRespawn` rebuild from the new config — but never behind the
user: store the change, flag it pending, and offer **Reconnect now** with an explanation.

## Network, relay & streams

**Size a per-socket burst allowance by what that socket has proven, not a constant.** A fixed burst
plus a consecutive-drop ban is a cliff at `burst + threshold`. Keep the bucket as decaying debt and
decay the drop counter at the refill rate.

**Never destroy a peer's socket to heal a wedged replication session.** It carries every channel for
that peer. Capture via an explicit bounded `get`, falling back to
`bee.checkout(core.contiguousLength)`.

**Latency injection must preserve FIFO.** Release frames through one queue with
`at = max(now + latency + rand(jitter), prevFrameAt)`, overriding `.write` in place (Protomux reads
`.remotePublicKey` off the Noise stream).

**`rawBytesRead` advances per frame, not per packet.** Liveness signals read `stream.rawStream`
(`bytesReceived` on udx, `bytesRead` on TCP). An idle connection still carries keep-alive frames.

**Decode NDJSON on the newline byte, never `buffer += chunk.toString()`.** A split multi-byte
character decodes to U+FFFD on both halves and `JSON.parse` succeeds. `0x0A` never occurs inside
UTF-8 sequences.

**Relay attribution is visible only through `blind-relay`'s `Client.from` + `'pair'` event.**
hyperdht discards it. Relayed is transient (udx `'remote-changed'` upgrades it), so compare
endpoints rather than caching a boolean.

**A relay setting reaches only the next connection.** Apply a change by dropping the sockets; clear
`peerInfo.forceRelaying`, which hyperdht latches and never clears. `off` removes only our
contribution — the peer's relay still applies.

**Freeze the facts that decided a connection's path at pairing time.** Record `via`/`relayMode` per
connection so a mode change can tell old connections from new. Provenance comes from the pairing's
`isInitiator` and an installed relay function, never key equality with the config slot.

**A per-connection array in the status frame needs a scalar digest beside it.** The dedup compares
leaves only.

## Platform & packaging

**Preallocating with `ftruncate` is sparse on APFS/ext4 and real on NTFS.** Preflight with
`statfsSync` and pause on ENOSPC; never retry on a full disk.

**A packaged app's argv is written by the OS.** Split OS-supplied positionals (a `mirall://` link on
Windows/Linux) out before a strict parse, and downgrade any remaining bail to a warning.

**A deep link through a browser or chat can gain a trailing slash.** Strip both ends. The extractor
exists in `main/deeplink.js` and `contract/invite-envelope.js` — fix both.

**Gate a fixed-length encoded credential on string length before decoding.** A z-base-32 final
character can be pure slack, so a checksum can't see a truncation.

**chokidar emits no event for a file unreadable at report time.** A permission fault on read is
found only by a scan.

**A cheap per-row fs check is worth batching only when the syscall count is the cost.** `readdir` is
O(directory) and byte-exact where `existsSync` case-folds; memoize the repeated folder probe
instead.

## Security

**Gate member-only operations by capability at the worker boundary.** Name the lesser capability an
op still leaks (e.g. the topic key → join-request spam) and refuse at the data layer if it's
unacceptable.

**Enforce path containment read-side.** A peer can append raw entries that bypass Hyperdrive's
normalization. `startsWith(root)` isn't a boundary; compare a separator-terminated prefix or use
`path.relative`.

**A `profileKey` is a manifest hash, not an ed25519 key.** Rebuild the manifest from `signerKey` +
`signerNs` and check it hashes to the `profileKey`; never answer a `membership:request` naming
someone else's key with the SCK.

**Classify each plaintext field before calling it a leak.** Needed before the gating key exists →
public by design; a pointer to encrypted data → safe; sensitive data not needed pre-membership → the
real bug. Check key granularity before proposing "encrypt the bee".

## Release & build

**Prerelease channels use single-drive `pear stage` + `pear release`.** Their `upgrade-keys.json`
entry is a string, and versions must increase monotonically (`-beta.<run>`). Only prod uses
`{stage, provision}`. `pear touch` the seed drive on the seed VM first, or staging fails
`SESSION_NOT_WRITABLE`.

**`UPGRADE_KEY_PROD` must equal the seed VM's `production.provision` key.** It's baked in at build
time; rotate both together, then release.

**macOS codesign `Sealed Resources=none` / `Signature=adhoc` is a transient flake.** Re-run the job.

**Pin `signtool`'s Windows SDK to the runner image's AppxSip build.** A mismatch signs a package
that fails to install on users' machines.

**A capability gated on "all credentials present" needs an else-branch that fails loudly.** An unset
notarization var shipped signed-but-unnotarized DMGs.

**Date a CI credential break by the secrets' `created_at`/`updated_at`.**
`gh api repos/OWNER/REPO/actions/secrets`; equal timestamps mean added, never rotated.

**Quantify packaging deltas against a CI-equivalent build.** A gitignored subproject `node_modules`
on disk isn't in the artifact.
