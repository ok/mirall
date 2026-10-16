# Layout harness (`npm run test:layout*`)

Real-Chromium layout tests, complementary to `test/frontend/` (which drives the AX tree and cannot
read pixel layout). Each runner mounts REAL components inside the real app-shell wrappers with the
real built `app.css`; `window.bridge` is faked (`fake-bridge.js`) so `ipc.ts`, the hooks and the
components run unmodified. `harness-bootstrap.ts` gives every harness the query store's transport.

| `npm run` | Runner | Mounts | Invariant |
|---|---|---|---|
| `test:layout` | `run.mjs` | `<FolderView>` under the mirror-download re-render storm | the document never scrolls |
| `test:layout:case -- members` | `run-members.mjs` | `<SpaceView>` Members box, small + large roster | small hugs its content; large caps at the column and scrolls inside |
| `test:layout:case -- approval` | `run-approval.mjs` | `<SpaceView>` with a pending join request | the in-flight affordance renders while approve/deny is pending |
| `test:layout:case -- denyapproved` | `run-denyapproved.mjs` | `<SpaceView>` with a pending request a co-member already approved | Deny disables in flight; the already-approved outcome is a sticky polite status toast, never an alert; a deny with nothing open is a polite notice |
| `test:layout:case -- darkshadow` | `run-darkshadow.mjs` | `<OnboardingScreen>` + `<TopNav>`, light + dark | the ambient mauve lift is there in light mode and gone in dark mode |
| `test:layout:case -- callouts` | `run-callouts.mjs` | `<Callout>` in both tones beside a `<TextField>`, light + dark | a note sits on the field gray, a warning on the amber container, never on the `-high` plate |
| `test:layout:case -- fields` | `run-fields.mjs` | `<TextField>` on a modal panel and a card, `<SearchField>`, `<PathRow>`, `<Account>`, `<OnboardingScreen>`, `<RestoreProgress>` waiting for a holder, `<ListControlsRow>`, `<Toggle>` off and on, light + dark | placeholders and error text clear 4.5:1, a field stands off its card, a switch clears 3:1 in either state |
| `test:layout:case -- dropoverlay` | `run-dropoverlay.mjs` | the full-bleed Drop-to-Share overlay | covers the pane edge to edge at the shipped inset |
| `test:layout:case -- sharecard` | `run-sharecard.mjs` | `<ShareCard>` | the whole card is the hit area; actions stay inside it |
| `test:layout:case -- pokescope` | `run-pokescope.mjs` | `useFiles`, two `useShareFiles` and `useSpaceStorage` on one space under the real query store | a loose hint re-reads the loose list and the total; a folder hint that folder and the total; the space-wide hint every listing; another space or the retired `files` kind nothing |
| `test:layout:case -- progress` | `run-progress.mjs` | progress lanes | ARIA valuenow/valuetext follow the lane's mode |
| `test:layout:case -- peerdownload` | `run-peerdownload.mjs` | `<PeerDownloadIndicator>` + `<PeerDownloadRow>` at lane width | meta un-clipped; bar right-aligned; name yields before `speed · ETA`; % fallback during warmup |
| `test:layout:case -- avatars` | `run-avatars.mjs` | the `Avatar` matrix + member row, top bar, Activity Log, first-run picker | every avatar-shaped disc is recessed; the presence dot stays on its corner |
| `test:layout:case -- facepile` | `run-facepile.mjs` | `<SpaceCard>`'s `<AvatarStack>`, light + dark | every ring carries the fill of the card behind it — fading in step with it — at rest and on hover; every disc is recessed and stays visible |
| `test:layout:case -- filecard` | `run-filecard.mjs` | `<FileRow>`s of both kinds (loose: one at rest, two failed; folder: one at rest, one failed) + `<ToastContainer>` | a failed row of either kind keeps its kind's resting height; toasts grow to the 720px cap |
| `test:layout:case -- modaltitle` | `run-modaltitle.mjs` | confirm modals with long names | the title never overflows the panel |
| `test:layout:case -- logohover` | `run-logohover.mjs` | `<TopNav>` | the logo never greys out on hover |
| `test:layout:case -- mirrorers` | `run-mirrorers.mjs` | `<FolderPeopleCard>` | facepile cap + "+N"; ring colour encodes state; toggle flush right |
| `test:layout:case -- indexing` | `run-indexing.mjs` | `<FolderTree>` owner mid-index, member waiting | the indexing label matches the role |
| `test:layout:case -- memo` | `run-memo.mjs` | a memoized list under the 1 Hz heartbeat | rows whose props did not change do not re-render |
| `test:layout:case -- overflowloop` | `run-overflowloop.mjs` | a consumer whose content fits only when padded, then `<SpacesScreen>` walked across its overflow boundary (1px, then 0.05px), in production React | the overflow flag never locks the renderer (no #185) and the list settles at every height |
| `test:layout:case -- spaceoverflow` | `run-spaceoverflow.mjs` | `<SpaceView>` with more rows than the pane | the document never scrolls |
| `test:layout:case -- stickyheader` | `run-stickyheader.mjs` | `<SpaceView>` with both sections overflowing | pinned headers sit flush on the scrollport; the top control keeps ring room |
| `test:layout:case -- folderselecting` | `run-folderselecting.mjs` | `<FolderScreen>` on a browse folder three levels deep, at 900px and 1400px | at rest the first row's left edge is the controls row's; with the column open every box sits at one x whatever the depth, with ring room inside the pane; the document never scrolls |
| `test:layout:case -- spaceselecting` | `run-spaceselecting.mjs` | `<SpaceScreen>` with folders and loose files, at 900px | with the column open every box sits at one x, the Files Shared header still pins flush on the scrollport, the document never scrolls |
| `test:layout:case -- focusring` | `run-focusring.mjs` | `<FolderView>` | every focusable control's ring is unclipped |
| `test:layout:case -- rowfocus` | `run-rowfocus.mjs` | `<Settings>`, `<NotificationSettings>`, `<AppearanceSettings>`, an `ActionRow` group | a focused grouped row is tinted, its ring is inset and follows the group's corners where it meets the edge |
| `test:layout:case -- truncation` | `run-truncation.mjs` | `<PathRow>`, loose `<FileRow>`s (one downloading), a `<FolderTree>` folder row with a file row inside, and a `<ShareCard>` in narrow fields, read once fonts load | nothing overflows; a path keeps its last segment; a name keeps both ends and more than its extension (dotted folder/share names split evenly), a short one renders whole, the full name is the accessible name; a hit on the card's icon resolves to a title carrying it, but the progress bar and Browse Files keep theirs; a name's natural width is the whole name's |
| `test:layout:case -- waiting` | `run-waiting.mjs` | a loose `<FileRow>` mid-hash with members waiting, three row widths | the waiting cluster yields before the hash bar; nothing overflows; only a narrow row sheds the stack |
| `test:layout:case -- recipients` | `run-recipients.mjs` | a loose and a folder `<FileRow>` with two of three members holding the file, four row widths | the cluster sheds before the name: no overflow, a one-line toggle, faces only when wide, "2/3" when narrow |
| `test:layout:case -- segments` | `run-segments.mjs` | `<SegmentedControl>` in its three shapes | the track and every segment keep their size across selections |
| `test:layout:case -- errorassoc` | `run-errorassoc.mjs` | `<EditSpaceModal>`, `<EditFolderModal>`, `<MountPathField>`, `<CreateSpaceModal>` in failure | each field marks itself invalid and describes itself with its OWN error; no submit rejection escapes |
| `test:layout:case -- failpaths` | `run-failpaths.mjs` | `<Account>`, `<AboutScreen>`, `<ActivityLogSettings>`, `<NetworkDiagnosticsScreen>`, `<CopyButton>`, `<InviteModal>` under the real `<ToastProvider>`, with the worker and the clipboard rejecting | the control is usable again, nothing reports success, the reason is an alert toast, no rejection escapes; a failing run names each failed probe |
| `test:layout:case -- toastdedupe` | `run-toastdedupe.mjs` | the real `<ToastProvider>` under a retried failure | one sentence said three times is one toast, remounted each time; a different sentence still stacks |
| `test:layout:case -- toaststack` | `run-toaststack.mjs` | the real `<ToastProvider>` under a burst behind a sticky toast | a sticky toast is never evicted; the oldest auto-dismissing one makes room; stickies alone let the stack grow |
| `test:layout:case -- transferfaults` | `run-transferfaults.mjs` | the real `<ToastProvider>` + `<WorkerToastBridge>` and the notification dispatcher under a burst of per-file transfer errors | one toast, mounted once; one OS notification re-shown once under the same id with the file count; another fault or space is its own toast |

Append `--no-build` to any runner to reuse the existing bundle. Exit `0` = the invariant held; on
failure each runner prints the measured metrics. **Local/dev-machine only** — they spawn a real
(hidden) Electron GUI process, like `npm run test:fe`; headless CI cannot run them.
