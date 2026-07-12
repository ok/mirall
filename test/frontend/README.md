# Frontend UI test scenarios

End-to-end UI scenarios that drive the **real Electron app** via `agent-desktop` (the macOS accessibility tree). Each scenario launches one or two real instances, performs user actions through the rendered UI (and through the native file/folder pickers), and asserts on what the user sees.

- **Runner:** `node test/frontend/run.mjs [s5 s6 …]` (no args = all). Add `--no-build` to skip the rebuild.
- **Requires `agent-desktop` >= 0.3.0** (`npm install -g agent-desktop@latest`). 0.3.0 reintroduced persisted, **session-scoped snapshots**, so a ref taken from a snapshot survives the separate CLI invocations this harness makes (snapshot in one process, click/type/get in the next). The harness gives each instance its own `--session` namespace and passes `--headed` for the cursor commands (`hover`/`mouse-move`). **Avoid 0.2.x:** it re-resolved refs per-command, so every cross-process ref returned `STALE_REF` and the suite stalled. The runner preflights the version (floor in `preflight.mjs`) and the macOS **Accessibility** permission (Screen Recording is also needed for screenshots) and aborts early with guidance if either is wrong.
- **Local/dev-machine only.** Headless CI cannot drive the macOS AX tree, so this suite is run on a developer machine and its evidence screenshots (`test/frontend/evidence/`) are the record. See `.claude/testing.md`.
- **Harness:** `instance.mjs` (the `Instance` class — launch, onboarding, navigation, file/folder actions, AX queries), `helpers.mjs` (`connectInSpace`), `assert.mjs` (`makeReport`, `assert`, `waitFor`, `dirSize`).
- **Speed:** to keep per-action latency down, `agent.mjs` caps agent-desktop's activation-chain deadline (default 10 s) so an action that can't settle fails fast into `withRetry` instead of stalling — override with `AGENT_DESKTOP_CHAIN_TIMEOUT_MS` if a slow control needs longer; single-instance scenarios skip the per-action `list-windows`/re-focus (no competing window), and `_ref` resolves against an interactive-only snapshot.

### Why several flows can *only* be proven here

Owner-side filesystem operations — adding, editing, deleting, moving, or copying files inside a shared folder, and creating subfolders — reach the data layer through the **chokidar watcher in Electron main**. The backend flow tests (`test/flow/`) run the worker as a bare subprocess with **no Electron main**, so they *inject synthetic* `owned-folder-fs-event` IPC frames to stand in for the watcher. This frontend suite runs the real app, so it is the **only** layer that exercises the genuine *filesystem → chokidar → publish → replicate → materialize* path. That is exactly where the gaps below concentrate, and why they matter most at this layer.

---

## Scenarios

### A. App shell, navigation & command palette
| ID | File | Covers |
|----|------|--------|
| s1 | `s1-shell.mjs` | Boot → Shared Spaces; Feedback modal opens; ⌘K command palette opens. |
| s20 | `s20-command-palette.mjs` | ⌘K → search → Enter opens Create Space; ⌘N opens it directly. |
| s21 | `s21-empty-states.mjs` | Empty-state copy: no spaces, empty Favorites tab, empty-share copy in a new space. |

### B. Onboarding, profile & network
| ID | File | Covers |
|----|------|--------|
| s22 | `s22-onboarding-validation.mjs` | Welcome screen; whitespace-only name keeps Continue disabled; a real name advances. |
| s14 | `s14-account.mjs` | Rename self in Account → the new display name propagates to a peer's member list. |
| s17 | `s17-network-status.mjs` | Network status screen; advanced details + masked-field reveal/hide; reconnect affordance. |

### C. Spaces lifecycle (create / join / edit / invite)
| ID | File | Covers |
|----|------|--------|
| s2 | `s2-connect.mjs` | Create space + join by invite code; membership converges both ways. |
| s3 | `s3-join-errors.mjs` | Join disabled until a code is entered; malformed code → inline error. |
| s13 | `s13-edit-space.mjs` | Rename space + change icon; favorite it and find it under Favorites. |
| s19 | `s19-invite-formats.mjs` | Invite format toggle: bare Code vs `mirall://join/` App link. |

### D. Settings & appearance
| ID | File | Covers |
|----|------|--------|
| s8 | `s8-settings.mjs` | Appearance Dark theme sets pressed state; a notifications switch toggles. |
| s15 | `s15-appearance.mjs` | Zoom-level pressed state; language switch (Deutsch ↔ English) re-renders. |
| s16 | `s16-general-notifications.mjs` | Launch-at-login switch and play-sound switch round-trip. |
| s18 | `s18-about.mjs` | About: version string is copyable; What's New modal opens. |

### E. Storage management
| ID | File | Covers |
|----|------|--------|
| s7 | `s7-storage.mjs` | Manage Storage → clear peer cache completes; space stays intact. |

### F. Loose file sharing
| ID | File | Covers |
|----|------|--------|
| s4 | `s4-transfer.mjs` | Share a loose file; peer sees it; **FIX-3** download does not overwrite a pre-existing file (`report (1).txt`). |
| s10 | `s10-file-actions.mjs` | Peer downloads a loose file to completion; "Reveal in Folder" appears. |
| s11 | `s11-remove-file.mjs` | Owner unshares a loose file via RemoveFileModal → removal propagates to the peer. |

### G. Owned folders — owner side
| ID | File | Covers |
|----|------|--------|
| s5 | `s5-owned-folder.mjs` | Share an owned folder; peer receives it; **REGRESSION** re-adding an already-shared folder shows a plain-language reason; **FIX-1** leave-while-mounted doesn't crash. |
| s9 | `s9-folder-lifecycle.mjs` | Delete an owned folder via card menu + confirm → tombstone disappears for the peer. |
| s12 | `s12-add-folder-validation.mjs` | AddFolder validation: name-collision error and invalid-name error each block "Next: Preview". |
| s23 | `s23-relocate.mjs` | Source folder moved on disk → "missing on disk" state → Locate re-points the share ("Reconnected"). |

### H. Mirroring — peer side
| ID | File | Covers |
|----|------|--------|
| s6 | `s6-mirror.mjs` | Mirror a folder to disk (files land, "Mirrored" badge); pause/resume shows "Paused"; unmount reverts to "Browse". |
| s24 | `s24-unmount-in-folder.mjs` | **REGRESSION (FIX-UNMOUNT-NAV)** unmounting from inside FolderView stays in the folder (now a browse share); status pills refresh to "Available". |
| s25 | `s25-mirror-paused-in-folder.mjs` | **REGRESSION (FIX-PAUSE-INDICATION)** pausing inside FolderView shows "Syncing is paused"; resuming clears it. |

### I. Owned folders — live file operations (ongoing edits to a shared folder)
These drive the real *filesystem → chokidar → publish → replicate → materialize* path: the scenario mutates files on disk in the owner's mount directory, the running app's watcher publishes, and the scenario asserts on the peer's folder view and the mirror's on-disk contents.

| ID | File | Covers |
|----|------|--------|
| s26 | `s26-add-file-to-folder.mjs` | Owner adds a file to a shared folder → it appears in the peer's folder view and lands on the mirror's disk. |
| s27 | `s27-delete-file-in-folder.mjs` | Owner deletes a file → removed from the peer + mirror; the folder's other files stay (not the "folder emptied" transient). |
| s28 | `s28-subfolder.mjs` | Owner creates a nested subfolder with a file → it replicates and materializes at the right depth on the mirror. |
| s29 | `s29-move-into-subfolder.mjs` | Owner moves a file into a subfolder → mirror reflects the move with **no stale duplicate and no lost file**. |
| s30 | `s30-delete-file-in-subfolder.mjs` | Owner deletes a nested file → only it leaves the mirror; its sibling is untouched. |
| s31 | `s31-edit-and-readonly-revert.mjs` | Owner edit updates content on the mirror; **a local edit of a read-only mirror file is reverted** to the owner's version on the next sync. |
| s32 | `s32-mirror-keeps-unrelated-file.mjs` | Mirroring into a folder that already holds the user's own file → it survives the initial scan **and** a later owner deletion (only synced files are removable). |
| s33 | `s33-copy-file.mjs` | Owner duplicates a file (same content, new path) → both copies publish and materialize. |
| s34 | `s34-nested-initial-share.mjs` | Initial share of a realistic nested tree (files across several subfolders) → the whole tree replicates and materializes at the right depths. |
| s35 | `s35-live-folder-refresh.mjs` | Peer has the FolderView open → an owner add/remove appears/disappears live, without re-navigating. |
| s36 | `s36-browse-download-subfolder.mjs` | Browse-only peer downloads a file from a subfolder on demand → lands in the global download folder. |
| s37 | `s37-large-file.mjs` | A 12 MiB file mirrors **byte-exact** (full content compare, not just size). |
| s38 | `s38-multiple-folders.mjs` | Two owned folders coexist in one space; a mirror of one keeps syncing independently after the second is shared. |
| s39 | `s39-ignored-junk.mjs` | `.DS_Store` / `*.mirall.part` in an owned folder are never published to the peer. |
| s40 | `s40-empty-subfolder.mjs` | An empty subfolder doesn't replicate (graceful, no crash); it materializes once its first file lands. |
| s41 | `s41-owner-offline.mjs` | Owner goes offline → the open folder shows the offline banner and the file drops to "Not available". |

---

## Coverage map

Groups A–I above are the full UI suite. Owned-folder behaviour is exercised end-to-end through the real *filesystem → chokidar → publish → replicate → materialize* path, in two layers:

- **Setup** — share, mirror, delete, relocate, unmount, pause (groups F–H).
- **Live file operations** on an already-shared folder — add, delete, edit, move, copy, subfolders/nesting, multiple folders, ignored junk, empty subfolders, large files, owner-offline (group I).

Loose-file sharing (group E) and the non-sharing surfaces — shell, spaces, settings, onboarding, account, storage (groups A–E) — are covered alongside.

## Not covered at this layer

Some guarantees are deliberately proven at a lower layer, or need a harness addition. Per `.claude/testing.md`, don't force a flaky UI assertion for something a lower layer proves better — these UI scenarios assert the **user-visible outcome** (a file appears/disappears, a badge changes, bytes land on disk), while byte-level guarantees live in `test/flow/` and `test/integration/`.

| Gap | Status / where it lives instead |
|---|---|
| **`awaitWriteFinish` timing** — no premature publish of a still-being-written file | Chokidar-config property; too racy to assert in the UI window. s37 asserts byte-exact integrity of the settled file. |
| **Same-named folders from two owners** disambiguate | `test/integration/share-registry` (per-owner name uniqueness; dedupe by `owner:id`). Not UI-drivable — two identically-named cards expose ambiguous `Open <name>` selectors. |
| **Fully empty top-level folder** share | Not yet covered: the scan-preview modal omits the "Upload" line at 0 files, which the `addOwnedFolder` helper waits on (would need a preview-helper tweak). s40 covers the empty-*subfolder* case. |
| **Owner returns → mirror catches up** | `test/flow/{offline-transfer,resume-transfer,foreign-sync}`. The harness `kill()` wipes the store, so suspend/relaunch isn't available; s41 covers offline *detection*. |
| **Mirror error states** (`paused-enospc`, `paused-error`) | Backend (`applyChange` pause paths). Hard to induce in the UI; a scenario would only confirm the badge given a forced state. |
