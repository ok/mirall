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
| `test:layout:case -- dropoverlay` | `run-dropoverlay.mjs` | the full-bleed Drop-to-Share overlay | covers the pane edge to edge at the shipped inset |
| `test:layout:case -- sharecard` | `run-sharecard.mjs` | `<ShareCard>` | the whole card is the hit area; actions stay inside it |
| `test:layout:case -- progress` | `run-progress.mjs` | progress lanes | ARIA valuenow/valuetext follow the lane's mode |
| `test:layout:case -- peerdownload` | `run-peerdownload.mjs` | `<PeerDownloadIndicator>` + `<PeerDownloadRow>` at lane width | meta un-clipped; bar right-aligned; name yields before `speed · ETA`; % fallback during warmup |
| `test:layout:case -- avatars` | `run-avatars.mjs` | the `Avatar` matrix + member row, top bar, Activity Log, first-run picker | every avatar-shaped disc is recessed; the presence dot stays on its corner |
| `test:layout:case -- facepile` | `run-facepile.mjs` | `<SpaceCard>`'s `<AvatarStack>`, light + dark | every ring carries the fill of the card behind it — fading in step with it — at rest and on hover; every disc is recessed and stays visible |
| `test:layout:case -- filecard` | `run-filecard.mjs` | three `<FileCard>`s + `<ToastContainer>` | a failed row keeps the resting height; toasts grow to the 720px cap |
| `test:layout:case -- modaltitle` | `run-modaltitle.mjs` | confirm modals with long names | the title never overflows the panel |
| `test:layout:case -- logohover` | `run-logohover.mjs` | `<TopNav>` | the logo never greys out on hover |
| `test:layout:case -- mirrorers` | `run-mirrorers.mjs` | `<FolderPeopleCard>` | facepile cap + "+N"; ring colour encodes state; toggle flush right |
| `test:layout:case -- indexing` | `run-indexing.mjs` | `<FolderTree>` owner mid-index, member waiting | the indexing label matches the role |
| `test:layout:case -- memo` | `run-memo.mjs` | a memoized list under the 1 Hz heartbeat | rows whose props did not change do not re-render |
| `test:layout:case -- spaceoverflow` | `run-spaceoverflow.mjs` | `<SpaceView>` with more rows than the pane | the document never scrolls |
| `test:layout:case -- stickyheader` | `run-stickyheader.mjs` | `<SpaceView>` with both sections overflowing | pinned headers sit flush on the scrollport; the top control keeps ring room |
| `test:layout:case -- focusring` | `run-focusring.mjs` | `<FolderView>` | every focusable control's ring is unclipped |
| `test:layout:case -- truncation` | `run-truncation.mjs` | `<PathRow>` + `<FileName>` in a narrow field | exactly one run truncates; nothing overflows |
| `test:layout:case -- waiting` | `run-waiting.mjs` | `<FileCard>` mid-hash with members waiting, three row widths | the waiting cluster yields before the hash bar; nothing overflows; only a narrow row sheds the stack |
| `test:layout:case -- segments` | `run-segments.mjs` | `<SegmentedControl>` in its three shapes | the track and every segment keep their size across selections |
| `test:layout:case -- errorassoc` | `run-errorassoc.mjs` | `<EditSpaceModal>`, `<EditFolderModal>`, `<MountPathField>`, `<CreateSpaceModal>` in failure | each field marks itself invalid and describes itself with its OWN error; no submit rejection escapes |
| `test:layout:case -- failpaths` | `run-failpaths.mjs` | `<Account>`, `<ActivityLogSettings>`, `<NetworkDiagnosticsScreen>`, `<CopyButton>`, `<InviteModal>` under the real `<ToastProvider>`, with the worker and the clipboard rejecting | the control is usable again, nothing reports success, the reason is an alert toast, no rejection escapes |
| `test:layout:case -- toastdedupe` | `run-toastdedupe.mjs` | the real `<ToastProvider>` under a retried failure | one sentence said three times is one toast, remounted each time; a different sentence still stacks |
| `test:layout:case -- toaststack` | `run-toaststack.mjs` | the real `<ToastProvider>` under a burst behind a sticky toast | a sticky toast is never evicted; the oldest auto-dismissing one makes room; stickies alone let the stack grow |

Append `--no-build` to any runner to reuse the existing bundle. Exit `0` = the invariant held; on
failure each runner prints the measured metrics. **Local/dev-machine only** — they spawn a real
(hidden) Electron GUI process, like `npm run test:fe`; headless CI cannot run them.
