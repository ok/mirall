# Layout harness (`npm run test:layout*`)

Real-Chromium layout tests, complementary to `test/frontend/` (which drives the AX tree and cannot
read pixel layout). Each runner mounts REAL components inside the real app-shell wrappers with the
real built `app.css`; `window.bridge` is faked (`fake-bridge.js`) so `ipc.ts`, the hooks and the
components run unmodified. `harness-bootstrap.ts` gives every harness the query store's transport.

| `npm run` | Runner | Mounts | Invariant |
|---|---|---|---|
| `test:layout` | `run.mjs` | `<FolderView>` under the mirror-download re-render storm | the document never scrolls |
| `test:layout:members` | `run-members.mjs` | `<SpaceView>` Members box, small + large roster | small hugs its content; large caps at the column and scrolls inside |
| `test:layout:approval` | `run-approval.mjs` | `<SpaceView>` with a pending join request | the in-flight affordance renders while approve/deny is pending |
| `test:layout:dropoverlay` | `run-dropoverlay.mjs` | the full-bleed Drop-to-Share overlay | covers the pane edge to edge at the shipped inset |
| `test:layout:sharecard` | `run-sharecard.mjs` | `<ShareCard>` | the whole card is the hit area; actions stay inside it |
| `test:layout:progress` | `run-progress.mjs` | progress lanes | ARIA valuenow/valuetext follow the lane's mode |
| `test:layout:peerdownload` | `run-peerdownload.mjs` | `<PeerDownloadIndicator>` + `<PeerDownloadRow>` at lane width | meta un-clipped; bar right-aligned; name yields before `speed · ETA`; % fallback during warmup |
| `test:layout:filecard` | `run-filecard.mjs` | three `<FileCard>`s + `<ToastContainer>` | a failed row keeps the resting height; toasts grow to the 720px cap |
| `test:layout:modaltitle` | `run-modaltitle.mjs` | confirm modals with long names | the title never overflows the panel |
| `test:layout:logohover` | `run-logohover.mjs` | `<TopNav>` | the logo never greys out on hover |
| `test:layout:mirrorers` | `run-mirrorers.mjs` | `<FolderPeopleCard>` | facepile cap + "+N"; ring colour encodes state; toggle flush right |
| `test:layout:indexing` | `run-indexing.mjs` | `<FolderTree>` owner mid-index, member waiting | the indexing label matches the role |
| `test:layout:memo` | `run-memo.mjs` | a memoized list under the 1 Hz heartbeat | rows whose props did not change do not re-render |
| `test:layout:spaceoverflow` | `run-spaceoverflow.mjs` | `<SpaceView>` with more rows than the pane | the document never scrolls |
| `test:layout:stickyheader` | `run-stickyheader.mjs` | `<SpaceView>` with both sections overflowing | pinned headers sit flush on the scrollport; the top control keeps ring room |
| `test:layout:focusring` | `run-focusring.mjs` | `<FolderView>` | every focusable control's ring is unclipped |
| `test:layout:truncation` | `run-truncation.mjs` | `<PathRow>` + `<FileName>` in a narrow field | exactly one run truncates; nothing overflows |
| `test:layout:segments` | `run-segments.mjs` | `<SegmentedControl>` in its three shapes | the track and every segment keep their size across selections |

Append `--no-build` to any runner to reuse the existing bundle. Exit `0` = the invariant held; on
failure each runner prints the measured metrics. **Local/dev-machine only** — they spawn a real
(hidden) Electron GUI process, like `npm run test:fe`; headless CI cannot run them.
