# Layout harness (`npm run test:layout`)

A **real-Chromium layout test**, complementary to the agent-desktop suite in
`test/frontend/` (which drives the AX tree and can't read pixel layout).

It mounts the **real** `<FolderView>` inside the **real** app-shell wrappers
(`min-h-screen` root + `<main>` top-padding + the screen's
`h-[calc(100vh-5rem-var(--banner-h))]`, which sum to exactly the viewport), with
the **real** built `app.css`. `window.bridge` is faked (see `fake-bridge.js`) so
`ipc.ts`, the hooks, and the components all run unmodified — the fake just plays
the worker end of the bridge and lets the test push `share-file-progress` /
`share-files-updated` events.

It then reproduces the mirror-download **re-render storm** and, each frame,
checks whether the **document** (not the inner list) can be scrolled — i.e.
whether an OS-level scrollbar appears over empty space. The shell is a
fixed-viewport surface, so the document must never scroll.

## What it caught

A mirrored folder mid-download grew the document by ~24px and showed a flickering
OS scrollbar. Cause: the per-row `sr-only` status spans (`position:absolute`) had
**no positioned ancestor**, so they anchored to the initial containing block
(`<html>`) and the list's `overflow-y-auto` couldn't clip them — rows scrolled
below the fold dropped a 1px sr-only span past the viewport bottom. Fix: give the
file-list scroll pane `position: relative` so it contains (and clips) them.

## Members panel (`npm run test:layout:members`)

A second scenario sharing the same plumbing. It mounts the **real** `<SpaceView>`
(same shell wrappers, same faked bridge — extended with the few extra routes
`SpaceView`'s hooks call) in a deliberately **tall** window, expands the Members
box, and measures the expanded card against its sidebar column:

- **small roster** — the card must *hug its content*: there must be real empty
  space between the card's bottom and the column's bottom (`gapBelow`), and the
  list must not be scrolling internally.
- **large roster** (grown via `member-joined` events) — the card must *cap* at
  the column height (`gapBelow ≈ 0`) and the list must scroll **inside** it.

### What it caught

The expanded Members card stretched to the bottom of the screen even with two
members — `flex-1` on the `CollapsibleCard` fill root forced it to consume all
remaining column height. Removing `flex-1` from the root (and switching the inner
content wrapper + list region from `flex-1`, i.e. flex-basis `0`, to flex-basis
`auto`) lets the card size to its content while still shrinking + scrolling when
the roster overflows.

## Peer-download serve UI (`npm run test:layout:peerdownload`)

Mounts the **real** `<PeerDownloadIndicator>` (collapsed, at the shipped `basis-56` /
224px lane width) and `<PeerDownloadRow>` — the sender-side "who is downloading my
file" UI. It asserts the collapsed meta shows `count · speed · ETA` **un-clipped** at
lane width (and its `aria-valuetext` carries the same tokens), that the per-peer row
puts the name on the left and **right-aligns the avatar + bar** so the bar hugs the
row's right edge at ~half width with `speed · ETA` above it (measured via
`getBoundingClientRect`), that under width pressure the **name** yields while the
`speed · ETA` stays whole (measured via `scrollWidth`/`clientWidth`, which is why it
needs real Chromium + real fonts, not the AX tree), and that the row shows a
**percentage fallback** instead of a blank during speed warmup.

## FileCard error state + toast width (`npm run test:layout:filecard`)

Mounts three **real** `<FileCard>`s — at rest, failed (`TRANSFER_DISK_FULL`), and
failed with a long error + long file name — plus the **real** `<ToastContainer>`
with a short and a long message. It asserts a failed row keeps **exactly** the
resting row height (the error text must ride the existing meta line, not add a
third text row) while the error stays visible, announced (`role="alert"`), and
inside the card bounds; and that a long toast message grows the toast to its
**720px cap** while a short one hugs its content at the 280px floor.

### What it caught

The failed row rendered the error as an extra `<p>` under the meta line, growing
the card from 88px to 100px; and the toast capped at 480px, wrapping long
disk-full messages (which embed file names) to three cramped lines.

## Run

```
npm run test:layout              # FolderView document-overflow scenario
npm run test:layout:members      # SpaceView Members-panel sizing scenario
npm run test:layout:peerdownload # Peer-download serve-UI (meta clip + % fallback)
npm run test:layout:filecard     # FileCard error-state height + toast width cap
node test/frontend-layout/run.mjs --no-build          # reuse the existing bundle
node test/frontend-layout/run-members.mjs --no-build   # reuse the existing bundle
```

Exit code `0` = the scenario's invariant held. On failure each runner prints the
measured metrics so the contributor is self-evident.

**Local/dev-machine only** — they spawn a real (hidden) Electron GUI process, like
`npm run test:fe`. Headless CI can't run them.
