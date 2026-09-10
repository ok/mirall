# Frontend UI test scenarios

End-to-end UI scenarios that drive the **real Electron app** via `agent-desktop` (the macOS accessibility tree). Each scenario launches one or two real instances, performs user actions through the rendered UI (and through the native file/folder pickers), and asserts on what the user sees.

- **Runner:** `node test/frontend/run.mjs [s5 s6 …]` (no args = all). Add `--no-build` to skip the rebuild.
- **Requires `agent-desktop` >= 0.8.0** (`npm install -g agent-desktop@latest`). 0.3.0 reintroduced persisted, **session-scoped snapshots**, so a ref taken from a snapshot survives the separate CLI invocations this harness makes (snapshot in one process, click/type/get in the next); 0.7.0 made an over-budget snapshot return `ok:true` with `complete:false` instead of a `TIMEOUT` error, which the harness must read to avoid asserting against a truncated tree; 0.8.0 qualified refs by snapshot (`@<snapshot_id>:eN`) and gave ref actions their own `--timeout-ms` budget. The harness gives each instance its own `--session` namespace and passes `--headed` for the cursor commands (`hover`/`mouse-move`). Upgrading from a pre-0.5 CLI? The runner prunes the stale root refmap state that 0.8.x rejects. The runner also preflights the version (floor in `preflight.mjs`) and the macOS **Accessibility** permission (Screen Recording is also needed for screenshots) and aborts early with guidance if either is wrong.
- **Local/dev-machine only.** Headless CI cannot drive the macOS AX tree, so this suite is run on a developer machine and its evidence screenshots (`test/frontend/evidence/`) are the record. See `.claude/testing.md`.
- **Harness:** `instance.mjs` (the `Instance` class — launch, onboarding, navigation, file/folder actions, AX queries), `helpers.mjs` (`connectInSpace`), `assert.mjs` (`makeReport`, `assert`, `waitFor`, `dirSize`).
- **Speed:** to keep per-action latency down, `agent.mjs` caps agent-desktop's activation-chain deadline (default 10 s) so an action that can't settle fails fast into `withRetry` instead of stalling — override with `AGENT_DESKTOP_CHAIN_TIMEOUT_MS` if a slow control needs longer; single-instance scenarios skip the per-action `list-windows`/re-focus (no competing window), and `_ref` resolves against an interactive-only snapshot.

### Why several flows can *only* be proven here

Owner-side filesystem operations — adding, editing, deleting, moving, or copying files inside a shared folder, and creating subfolders — reach the data layer through the **chokidar watcher in Electron main**. The backend flow tests (`test/flow/`) run the worker as a bare subprocess with **no Electron main**, so they *inject synthetic* `owned-folder-fs-event` IPC frames to stand in for the watcher. This frontend suite runs the real app, so it is the **only** layer that exercises the genuine *filesystem → chokidar → publish → replicate → materialize* path. That is exactly where the gaps below concentrate, and why they matter most at this layer.

---

## Scenarios

One row per file in `scenarios/`; the id is the `run.mjs` argument (`node test/frontend/run.mjs s5 s6`).

### A. App shell, navigation & keyboard
| ID | File | Covers |
|----|------|--------|
| s1 | `s1-shell.mjs` | Boot → Shared Spaces; Feedback modal opens; ⌘K command palette opens. |
| s20 | `s20-command-palette.mjs` | ⌘K → search → Enter opens Create Space; ⌘N opens it directly; the palette reaches the Activity Log, a settings sub-page and the system commands. |
| s21 | `s21-empty-states.mjs` | Empty-state copy: no spaces, empty Favorites tab, empty-share copy in a new space, each with its docs card (real anchors, not buttons). |
| s110 | `s110-header-logo.mjs` | The header wordmark is an inline SVG: the top-bar logo stays one named ("Home") node that navigates home; the onboarding header exposes the wordmark as a named image. |
| s116 | `s116-keyboard-coverage.mjs` | ⌘1-9 Go-to-Space via the native menu, ⌘⇧P Profile, ⌘⇧L Activity Log, ⌘F its search field, ⌘⇧H back to the list. |
| s117 | `s117-space-switch-no-empty-flash.mjs` | Moving between spaces never paints an empty hero over content: not on entering a space, not on returning to the list, not on the warm path; a genuinely empty space still shows its hero. |
| s133 | `s133-modal-keyboard.mjs` | The dialog keyboard contract: Escape dismisses, ⌘Enter submits from a text field once, Enter reaches the primary action of a fieldless dialog and never fires a destructive confirm. |
| s136 | `s136-screen-header-parity.mjs` | Space and folder screens share one `EntityHeader`: back control, name and actions are present and going back restores the space header. |

### B. Onboarding, profile, network & diagnostics
| ID | File | Covers |
|----|------|--------|
| s22 | `s22-onboarding-validation.mjs` | Welcome screen; a whitespace-only name keeps Continue disabled; an 80-char name shows the counter at the cap; a real name advances. |
| s14 | `s14-account.mjs` | Rename self in Profile → the new display name propagates to a peer's member list; the field accepts the max length with a live counter. |
| s17 | `s17-network-status.mjs` | Network status screen (via Account): the reconnect control, shown only when the verdict is not online, is reachable by name when present. |
| s18 | `s18-about.mjs` | App info lives on the Profile page: the version is copyable, Settings offers no About tile, the old tagline is gone. |
| s105 | `s105-network-limits.mjs` | Settings ▸ Network transfer caps: presets, the Custom input and its floor advisory, clamp-on-commit, persistence across a reopen with no Unlimited flash; the screen carries no live network state. |
| s106 | `s106-network-relays.mjs` | Settings ▸ Network relays, one slot: add → auto-probe → replace → remove with an open key, the self-host guide link, the mode control absent (not disabled) with no relay, and the a11y contract of every control. |
| s108 | `s108-profile-groups.mjs` | Profile page groups render and each row reaches its destination (Connection → diagnostics, Activity Log → viewer); identity protection is static text; the Profile command lands here. |
| s112 | `s112-connection-problem.mjs` | The Connection problem screen: summary present and readable, raw NAT rows behind the advanced disclosure, reached through Network status. |
| s113 | `s113-diagnostics-export.mjs` | The diagnostics card: both toggles reachable by name; the preview modal shows the real bundle and the redacted preview carries no public key. |
| s137 | `s137-relay-invite.mjs` | Settings ▸ Network invite-ticket paths: truncated / malformed ticket errors, the private-relay confirm step and its cost copy, the pending reconnect explained in place, probe only after reconnect, replace/remove ask first. |

### C. Spaces lifecycle (create / join / edit / invite / roster)
| ID | File | Covers |
|----|------|--------|
| s2 | `s2-connect.mjs` | Create space + join by invite code; membership converges both ways. |
| s3 | `s3-join-errors.mjs` | Join disabled until a code is entered; malformed and expired codes → inline `role=alert` error; Enter in the code field submits. |
| s13 | `s13-edit-space.mjs` | Rename space + change icon; favorite it from the More menu and find it under Favorites. |
| s19 | `s19-invite-single-link.mjs` | The invite modal yields one `mirall://join/` link, revealed only after Create — no Code / App-link format selector. |
| s51 | `s51-members-foldout.mjs` | Sidebar foldouts: Members shows an avatar stack, "Show all" expands to a list with a pinned "Show less", Storage folds to its headline. |
| s62 | `s62-create-space-no-invite-code.mjs` | The "Space Created" confirmation shows no invite-code UI; Done lands in the new space. |
| s64 | `s64-join-link-paste.mjs` | Pasting a `mirall://join` App link into Join strips it to the bare code, which is accepted. |
| s76 | `s76-invite-create-flow.mjs` | Invite create-flow: configure (auto-approve off by default, three expiry presets, no link yet) → Create shows link + setting badges → Change returns with choices preserved. |
| s80 | `s80-space-switch-roster.mjs` | Roster and online set are per-space: a solo space shows no trace of another space's roster; switching back re-derives both. |
| s81 | `s81-space-card-facepile.mjs` | The spaces-grid card facepile shows a member's avatar (name only reachable through its accessible label) — the async full-roster path populates the card. |
| s111 | `s111-space-card-state.mjs` | The Members card's fold and stack-vs-list choice persist per space for the session and are independent; Storage does not fold; a second space keeps its own defaults. |

### D. Membership approval
| ID | File | Covers |
|----|------|--------|
| s54 | `s54-membership-approve-single.mjs` | Encrypted space: B joins and waits; A sees the request banner, Approve is targetable; approval clears B's waiting state. |
| s55 | `s55-membership-approve-batch.mjs` | Four accounts: three joiners wait; the list shows a "waiting" badge; the batch modal's Approve selected lets one in, Approve all the rest. |
| s56 | `s56-membership-deny-and-invite-toggle.mjs` | Deny → the joiner is told; the decline toast is sticky (hover does not auto-dismiss); the invite modal's Auto-approve toggle is off by default and togglable. |
| s57 | `s57-membership-deny-in-modal.mjs` | Denying in the batch modal removes that row immediately and leaves the others. |
| s58 | `s58-membership-convergence.mjs` | When the owner approves, a co-member's banner and its request toast clear too. |
| s59 | `s59-membership-cancel.mjs` | A joiner withdrawing a pending request clears "wants to join" on the member who saw it. |
| s60 | `s60-membership-waiting-pill.mjs` | The joiner's spaces-list card wears a "Waiting for approval" pill until approved. |
| s61 | `s61-member-identity-sync.mjs` | A late joiner renders a pre-existing co-member by real name from replicated records, never "Unknown". |
| s63 | `s63-pending-request-offline-convergence.mjs` | A co-member keeps surfacing a pending request (banner + "N waiting" pill) after the requester goes offline. |
| s65 | `s65-owner-convergence.mjs` | When a co-member approves, the owner stops showing the request and lists the new member. |
| s114 | `s114-waiting-docs-card.mjs` | A pending joiner sees the "Why am I waiting?" docs card; withdraw still works beside it. |
| s126 | `s126-activity-log-granted-actor.mjs` | The joiner's `membership.granted` row names the granter as actor, as one accessible node, in the Members category. |

### E. Settings, appearance & storage
| ID | File | Covers |
|----|------|--------|
| s8 | `s8-settings.mjs` | Appearance Dark sets pressed state and persists across a remount; a notifications switch toggles. |
| s15 | `s15-appearance.mjs` | Zoom-level pressed state persists across leaving and returning; language switch (Deutsch ↔ English) re-renders. |
| s16 | `s16-general-notifications.mjs` | Launch-at-login switch and play-sound switch round-trip. |
| s47 | `s47-cache-setting.mjs` | **Not in the runner** (`run.mjs` does not import it): drove the on-demand cache slider that left with the Free-up-space feature. |
| s52 | `s52-storage-other.mjs` | Storage Settings' app-storage disclosure is AX-targetable (`role=button`, name, `aria-expanded`) and expands into the measured breakdown. |
| s107 | `s107-space-download-folder.mjs` | Per-space download folder: switching moves nothing, a copy outside the new folder reads as not-downloaded, switching back restores it; changes apply on Save; Settings' folder is the modal's default. |
| s109 | `s109-download-folder-gone.mjs` | A vanished download folder: the failure names the folder (never "Transfer failed"), a sticky toast offers a way out, Storage Settings marks it unavailable, choosing a working folder clears both and the download succeeds. |

### F. Loose file sharing & transfers
| ID | File | Covers |
|----|------|--------|
| s4 | `s4-transfer.mjs` | Share a loose file; peer sees it; a download does not overwrite a pre-existing file (`report (1).txt`). |
| s10 | `s10-file-actions.mjs` | Peer downloads a loose file to completion; "Reveal in Folder" appears. |
| s11 | `s11-remove-file.mjs` | Owner unshares via RemoveFileModal → removal propagates to the peer. |
| s69 | `s69-loose-file-verified-row.mjs` | A downloaded+verified row and a still-remote row coexist; the verified badge sits left of the status pill with the action on the right. |
| s71 | `s71-loose-source-change-restart.mjs` | The source changes on the sender mid-download → the receiver is told, restarts on the new content and ends verified. |
| s73 | `s73-peer-download-indicator.mjs` | The owner's row shows who is downloading (expander + per-peer list) while a peer pulls, and clears when the file lands. |
| s74 | `s74-peer-download-multi.mjs` | Three peers pull one file: the owner's multi-peer indicator and dropdown; clears when all three land. |
| s82 | `s82-loose-download-pause.mjs` | The loose FileCard exposes Pause / Resume mid-flight; the file lands "On your device". |
| s83 | `s83-loose-download-cancel.mjs` | Cancel a loose download mid-flight: the row reverts to Available, no partial lands. |
| s84 | `s84-loose-download-discard-partial.mjs` | Pause, then Discard Partial from the paused row: back to Available, partial removed. |
| s85 | `s85-cancel-publish-indexing.mjs` | Cancel a loose publish while still "Adding": the file never becomes a share for the peer. |
| s86 | `s86-loose-preparing-status.mjs` | While the owner indexes, the peer's row reads "Preparing…", settles to Available, downloads cleanly. |
| s87 | `s87-owner-crash-mid-index.mjs` | Hard-kill the owner mid-index and relaunch on the same store: it reboots into its space, not a stuck "Adding" zombie. |
| s88 | `s88-unshare-mid-download.mjs` | Owner unshares mid-download: the owner row is gone and the peer never falsely completes the removed content. |
| s91 | `s91-unshare-after-download.mjs` | Owner unshares a file the peer already has: the peer keeps its copy intact. |
| s92 | `s92-owner-offline-mid-download.mjs` | Owner goes offline mid-download: the peer's row flips to "Owner offline" and nothing completes. |
| s93 | `s93-owner-return-resume.mjs` | Owner offline long enough to be noticed, then back: the peer auto-resumes and completes. |
| s94 | `s94-manual-pause-survives-owner-return.mjs` | A manual pause survives the owner's reconnect — no auto-resume. |
| s95 | `s95-sender-sees-peer-paused.mjs` | The owner's indicator reflects a peer pausing, then clears when the peer completes. |
| s96 | `s96-two-peers-one-cancels.mjs` | Two peers download; one cancels, the other finishes; the owner's indicator drops the canceller and clears at the end. |
| s97 | `s97-two-peers-owner-unshares.mjs` | Two peers mid-download, the owner unshares: neither completes the removed content. |
| s98 | `s98-owner-leaves-mid-serve.mjs` | The owner leaves the space mid-serve: the peer does not complete, nothing is orphaned. |
| s99 | `s99-downloader-leaves-mid-download.mjs` | The downloader leaves mid-download: the transfer is purged, no file lands. |
| s100 | `s100-reshare-after-unshare.mjs` | Share, unshare, re-add the same file: the peer sees it, loses it, sees it again. |
| s101 | `s101-cancel-then-redownload.mjs` | Cancel mid-flight, then re-download: full-size on disk, no stale partial. |
| s102 | `s102-remove-readd-no-autoresume.mjs` | Owner removes a file mid-download then re-adds it: the receiver is told, the row clears, the file comes back re-downloadable and never auto-resumes. |
| s135 | `s135-row-lane-parity.mjs` | Loose and folder rows derive one lane: an indexing bar before any frame on both, and a named badge on the owner's row for both downloads. |

### G. Owned folders — owner side
| ID | File | Covers |
|----|------|--------|
| s5 | `s5-owned-folder.mjs` | Share an owned folder; peer receives it; the owner sees "Shared by you"; re-adding an already-shared folder shows a plain-language reason; leaving while mounted does not crash. |
| s9 | `s9-folder-lifecycle.mjs` | Delete an owned folder via card menu + confirm → the tombstone disappears for the peer. |
| s12 | `s12-add-folder-validation.mjs` | AddFolder validation: name-collision and invalid-name errors (`role=alert`, `aria-describedby`) each block "Next: Preview". |
| s23 | `s23-relocate.mjs` | Source folder moved on disk → "missing on disk" → Locate re-points the share. |
| s66 | `s66-overlay-folder.mjs` | A share publishes in place: no mode picker, no bytes imported, the peer sees the file from the catalog and fetches it by content hash. |
| s67 | `s67-overlay-toggle-hidden.mjs` | With overlay off, the Add Folder modal renders no "In place" segment (feature gate). |
| s70 | `s70-folder-card-hit-area.mjs` | The folder card's action menu is reachable above the full-bleed nav overlay, Escape dismisses it, clicking the card navigates. |
| s75 | `s75-folder-peer-download-indicator.mjs` | FolderView parity for the owner's "who is downloading" indicator on an in-place folder file. |
| s77 | `s77-folder-listing-no-flicker.mjs` | While the owner indexes a large folder, a browsing peer's open FolderView grows monotonically and never blanks. |
| s78 | `s78-folder-truncated-listing.mjs` | A folder over the listing cap renders the first N rows with a `role=status` banner naming the total, the limit and the listed count. |
| s79 | `s79-folder-source-missing.mjs` | The "source missing" banner appears and clears while the owner's FolderView stays open. |
| s103 | `s103-folder-tree.mjs` | Collapsible folder tree: top-level folders open by default, folder rows are AX-targetable buttons, expand / collapse-all / expand-all reveal and hide leaves. |
| s104 | `s104-add-folder-over-limit.mjs` | A folder over the share file limit is refused in the preview step, naming count and limit, with the confirm disabled. |
| s119 | `s119-folder-indexing-labels.mjs` | Dropped files are indexed, not transferred: the owner reads "Adding", the member "Preparing…", neither says downloading; both settle once indexed. |
| s120 | `s120-folder-index-summary.mjs` | A batch dropped in is announced on both screens including the files still queued; the notice clears when the scan drains; an owner that quits takes its notice with it. |
| s121 | `s121-index-pause-resume.mjs` | The index notice offers Pause; a paused folder says so and offers Resume; the pause is durable across a restart. |
| s122 | `s122-folder-filter.mjs` | The pinned controls row: the filter narrows the list and says by how much, no match keeps the tiles, clearing restores the expansion. |
| s123 | `s123-edit-folder.mjs` | Edit Folder from More: a healthy folder shows its location without offering to re-point it; saving a new name renames on screen and reopening shows it. |
| s124 | `s124-folder-commands.mjs` | The folder's acts are in the command palette only while it is open, Pause swings to Resume, the palette never lists itself, a browsed folder offers the mirror act instead. |
| s127 | `s127-folder-fault-strip.mjs` | An unreadable file in a shared folder surfaces the fault strip in plain language (never an errno), with a retry, durable across a restart, cleared by a clean pass. |

### H. Mirroring — peer side
| ID | File | Covers |
|----|------|--------|
| s6 | `s6-mirror.mjs` | Mirror a folder to disk (files land, "Mirrored" badge); pause / resume shows "Paused"; unmount reverts to "Browse". |
| s24 | `s24-unmount-in-folder.mjs` | Unmounting from inside FolderView stays in the folder (now a browse share); status pills refresh to "Available". |
| s25 | `s25-mirror-paused-in-folder.mjs` | Pausing inside FolderView shows "Syncing is paused"; resuming clears it. |
| s42 | `s42-mirror-file-progress.mjs` | Mirroring shows the same per-file download bar as a single download, resolves to downloaded, and exposes no pause / cancel controls. |
| s48 | `s48-folder-download-pause.mjs` | A FolderView single-file download exposes Pause / Cancel running and Resume / Discard paused (when the race allows); the file lands. |
| s49 | `s49-folder-download-cancel.mjs` | Cancel a FolderView download mid-flight: the row reverts to Available, no partial lands. |
| s50 | `s50-mirror-no-file-controls.mjs` | A mirrored folder never exposes per-file transfer controls; synced rows keep Reveal. |
| s68 | `s68-overlay-verified-check.mjs` | A mirrored in-place file's row shows a named "Verified" check, left of the status pill. |
| s89 | `s89-delete-share-mid-download.mjs` | The owner deletes the whole share mid-download: the peer stops offering the file and nothing lands. |
| s90 | `s90-delete-file-mid-download.mjs` | The owner deletes the source file on disk mid-download: the real watcher tombstones it, the peer's row clears, a sibling stays. |
| s118 | `s118-folder-never-blanks.mjs` | A peer browsing a folder keeps its rows when the owner drops offline; the header agrees; the listing is right when the owner returns. |
| s129 | `s129-mirror-modal-folder-info.mjs` | The Mirror to Disk modal reports the real file count and shows known counts on the first snapshot after a reopen. |
| s130 | `s130-mirror-name-collision.mjs` | Mirroring onto a folder holding a file at the share's name: the owner's copy lands at a sibling and both rows count as on-device. |
| s131 | `s131-mirror-fault-clears-on-unmount.mjs` | A mirror that cannot write its folder stops with a retry; unmounting clears the strip and its retry on the same screen. |
| s134 | `s134-mirror-over-cap-advisory.mjs` | Mirroring a share over the display cap warns before commit with the primary action still enabled (contrast s104, which refuses). |
| s138 | `s138-mirror-offline-quiet.mjs` | A mirrored folder whose owner is offline stays quiet — no rotating "Preparing…" badge under the offline banner. |
| s139 | `s139-mirror-offline-incomplete.mjs` | **REGRESSION (FIX-M4):** a mirror demonstrably short of the owner's listing must not read "Up to date" while the owner is away, and the People card must not call the mirrorer "Syncing…" when nothing is being fetched — the folder shows the `Owner offline` pill instead. |

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
| s34 | `s34-nested-initial-share.mjs` | Initial share of a realistic nested tree → the whole tree replicates and materializes at the right depths. |
| s35 | `s35-live-folder-refresh.mjs` | Peer has the FolderView open → an owner add/remove appears/disappears live, without re-navigating. |
| s36 | `s36-browse-download-subfolder.mjs` | Browse-only peer downloads a file from a subfolder on demand → lands in the global download folder. |
| s37 | `s37-large-file.mjs` | A 12 MiB file mirrors **byte-exact** (full content compare, not just size). |
| s38 | `s38-multiple-folders.mjs` | Two owned folders coexist in one space; a mirror of one keeps syncing independently after the second is shared. |
| s39 | `s39-ignored-junk.mjs` | `.DS_Store` / `*.mirall.part` in an owned folder are never published to the peer. |
| s40 | `s40-empty-subfolder.mjs` | An empty subfolder doesn't replicate (graceful, no crash); it materializes once its first file lands. |
| s41 | `s41-owner-offline.mjs` | Owner goes offline → the open folder shows the offline banner and the file drops to "Not available". |

### J. Activity log & localization
| ID | File | Covers |
|----|------|--------|
| s115 | `s115-activity-log-network.mjs` | The Network category chip is targetable by name / role / pressed state, an empty network log reads as good news, Clear all restores the list, all six chips are reachable, Network status cross-links in pre-filtered. |
| s125 | `s125-activity-log-folder-download.mjs` | A download out of a folder share appears in the Activity Log as a Files row that names the folder as well as the space. |
| s132 | `s132-activity-log-settings-parity.mjs` | The Account screen and the Activity Log settings screen report the same event count and recording state, from one store entry. |
| s128 | `s128-localized-errors.mjs` | In German, a malformed and an expired invite are rejected in German — the worker's code rendered through the errors catalog, never its English message. |
---

## Coverage map

Groups A–J above are the full UI suite. Owned-folder behaviour is exercised end-to-end through the real *filesystem → chokidar → publish → replicate → materialize* path, in two layers:

- **Setup** — share, mirror, delete, relocate, unmount, pause (groups F–H).
- **Live file operations** on an already-shared folder — add, delete, edit, move, copy, subfolders/nesting, multiple folders, ignored junk, empty subfolders, large files, owner-offline (group I).

Loose-file sharing (group F) and the non-sharing surfaces — shell, spaces, settings, onboarding, account, storage (groups A–E) — are covered alongside.

## Not covered at this layer

Some guarantees are deliberately proven at a lower layer, or need a harness addition. Per `.claude/testing.md`, don't force a flaky UI assertion for something a lower layer proves better — these UI scenarios assert the **user-visible outcome** (a file appears/disappears, a badge changes, bytes land on disk), while byte-level guarantees live in `test/flow/` and `test/integration/`.

| Gap | Status / where it lives instead |
|---|---|
| **`awaitWriteFinish` timing** — no premature publish of a still-being-written file | Chokidar-config property; too racy to assert in the UI window. s37 asserts byte-exact integrity of the settled file. |
| **Same-named folders from two owners** disambiguate | `test/integration/share-registry` (per-owner name uniqueness; dedupe by `owner:id`). Not UI-drivable — two identically-named cards expose ambiguous `Open <name>` selectors. |
| **Fully empty top-level folder** share | Not yet covered: the scan-preview modal omits the "Upload" line at 0 files, which the `addOwnedFolder` helper waits on (would need a preview-helper tweak). s40 covers the empty-*subfolder* case. |
| **Owner returns → mirror catches up** | `test/flow/{offline-transfer,resume-transfer,foreign-sync}`. The harness `kill()` wipes the store, so suspend/relaunch isn't available; s41 covers offline *detection*. |
| **Mirror error states** (`paused-enospc`, `paused-error`) | Backend (`applyChange` pause paths) + `test/unit/folder-strips` for the strip the two statuses now render. The OWNER half of the same surface is real end-to-end coverage (s127); the mirror half is not, because inducing a destination EACCES mid-materialize means chmod-ing the very directory the tick walks, so which call fails first is timing. |
