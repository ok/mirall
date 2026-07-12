# Changelog

All notable changes to Mirall are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and Mirall adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries describe changes you'll notice as a user. Internal refactors,
build-pipeline tweaks, and dependency bumps that don't change how the app
behaves are intentionally omitted. Releases that contained only such
changes do not appear here.


## v1.7.0
### 2026-07-12

This release adds approval-based space membership and is a major security
hardening update — see **Security** below. Existing installs upgrade and
migrate on their own, without changing your identity or your spaces.

This release also changes how Mirall shares your files — they're now served
directly from the originals on your computer, with no second copy kept
inside the app.

#### Added

- **Share straight from your files — no second copy.** Mirall used to
  import a private copy of everything you shared into its own storage. It
  now serves your shared files and folders directly from the originals on
  your computer, so sharing no longer doubles their disk usage, and edits
  to a shared file are picked up in place.
- **Approve who joins your spaces.** Joining a space is now a request:
  the person stays pending until an existing member approves them, and
  only then do they gain access to the space's contents. You'll see a
  "wants to join" banner and can approve or deny individually or in a
  batch; the person waiting sees a clear "waiting for approval" view.
  Prefer the old open behaviour? Flip on **auto-approve** when you create
  the invite and anyone with the code is admitted automatically. Until
  someone is a full member, member-only actions stay blocked for them.
- **See who's downloading from you.** When someone downloads a file
  you've shared, its row now shows their avatar — expand it to see each
  person individually, with live progress, transfer speed, and an
  estimate of how long they have left. Works for both individual files
  and shared folders.
- **Live speed and time-remaining on transfers.** Downloads now show
  their average speed and a steady estimate of the time remaining that
  settles down instead of jumping around. While you wait on a file, you
  can watch the owner's live preparation progress instead of a blank
  "Preparing…", and the owner sees an estimate while a file is being
  indexed.
- **Pause, resume, and stop transfers.** Downloads — single files and
  folders alike — can be paused and resumed, stopped outright, and pick
  back up on their own when the owner comes back online. Each finished
  file carries a "verified" badge confirming its contents match the
  original exactly.
- **Browse a shared folder as a collapsible tree.** Subfolders in a 
  Shared Folder are now rows you can open and close, and each one
  tells you what's inside at a glance: how many files it holds, their
  total size, how many are already on your device, and how many are
  downloading right now. **Expand all** and **Collapse all** fold the
  whole tree at once, and the folders you leave open stay open as you
  move around the app.
- **See who's mirroring a folder you shared.** A folder you own now
  shows the people keeping a live copy of it, each with their current
  state — synced, syncing, or paused. A single person shows by name;
  several stack into a row of avatars with a summary. The states stay
  accurate even while those people are offline.
- **A bigger target for drag-and-drop sharing.** Dragging a file
  anywhere over a space now expands the drop zone to fill the whole area,
  so it's easier to aim and drop files in to share.
- **Quit from the menu on Windows and Linux.** The File menu now offers
  "Quit Mirall" (Ctrl+Q), so you can fully quit the app instead of only
  closing it to the tray.

#### Security

- **Your local app data is encrypted on your device.** Mirall's local
  bookkeeping — your list of spaces, mirrored folders, downloads, and
  similar details — is now encrypted at rest with a key tied to your
  identity, so copying Mirall's data folder no longer exposes it. Existing
  data is migrated automatically the first time you open this version.
- **Only approved members can read a space.** A space's contents are now
  gated by a per-space key that's handed out only once an existing member
  approves your request to join — so being able to reach a space is no
  longer the same as being able to read what's shared in it.
- **Your identity is encrypted on your device.** Your signing key is now
  wrapped using your operating system's secure keychain and the plaintext
  is removed from storage, so copying Mirall's data folder no longer hands
  someone your identity. The Account screen shows this protection status.
- **Tougher against abusive peers.** Connection rate limits, sensible
  caps, and a firewall for misbehaving peers keep a flood of requests or
  oversized data from exhausting memory or CPU. Oversized avatars and
  over-long display names sent by a peer are now rejected, and your own
  avatar uploads are kept within sane bounds.

#### Changed

- **Simpler folder sharing.** Sharing a folder no longer asks you to pick
  a transfer mode. The previous "On demand" option, and the cache-size
  setting it added to Storage settings, have been removed — serving files
  in place from their originals covers the same need automatically, with
  no separate cache to manage.
- **Clearer, more consistent status colors.** File status labels now
  follow a fixed, meaningful palette: green when a file is on your device,
  blue while it's transferring, yellow when something needs your
  attention, and red for an error.
- **File sizes now match what your operating system shows.** Sizes were divided in binary (1024) steps
  but labelled with decimal units, so a file Finder reports as 629.68 GB could read as "586.4 GB".
  Sizes now use the same decimal units as macOS Finder and GNOME Files, and very large files no 
  longer show "undefined".
- **Invites now come only from inside the space.** Creating a space no
  longer hands you an invite code on the spot — it ends on a simple
  confirmation. To invite someone, open the space and use its **Invite**
  dialog: choose whether to auto-approve and how long the invite stays
  valid (2 hours, 2 days, or 2 weeks), then create a single link to
  share. Expired links are refused when someone tries to join.
- **A native Mac build for each processor.** Mirall now ships separate
  downloads for Intel and Apple Silicon Macs, so each gets a build matched
  to its processor instead of a single Apple-Silicon-only build.

#### Fixed

- **Shared files stay inside the shared folder.** Specially crafted file
  paths from a peer can no longer reach outside the folder you chose —
  neither to read or stream files from an owner's disk, nor to write or
  delete files on a mirror.
- **Mirroring never overwrites your own files.** If a shared file has the
  same name as one you already have, the mirrored copy now lands under a
  non-colliding name, and a peer can only ever remove its own mirrored
  copy — never your original. A mirror also can't be placed directly on a
  top-level personal folder such as Home, Desktop, Documents, or
  Downloads.
- **Member lists stay in sync for everyone.** We rebuilt how membership
  is shared between peers, so people no longer go missing, show up as
  "Unknown", or get stuck — and someone approved by one member now
  appears for everyone, not just the person who approved them. Members
  also show their real name and avatar even before a direct connection is
  made.
- **Leaving a space sticks, even if you quit part-way.** Quitting while 
  a space was still being left could bring it back on next launch; 
  the leave now completes instead of reappearing.
- **Files and members catch up on slow or flaky connections without a 
  restart.** On unreliable links a late-approved member might not see the
  space creator, and newly shared files could stay invisible until you 
  restarted. Mirall now keeps re-checking in the background until 
  everyone's view matches.
- **Pasted invite links work in the Join dialog.** Copying the "app link"
  form of an invite and pasting it into Join now works, not just the bare
  code.
- **Mirroring pauses instead of erroring when a write fails** — for
  example when your disk is full or the destination is read-only — and
  resumes once there's room, rather than retrying the failing file
  forever.
- **Fixed a crash when showing a notification on Windows** for certain
  spaces, members, or transfers.
- **Long names no longer overflow confirmation dialogs.** A long file,
  folder, or space name in a Remove, Leave, Delete, or Mirror dialog
  spilled out of the panel and pushed the close button aside. Names are
  now shortened in the middle, keeping the file extension readable.


## v1.6.1
### 2026-06-03

#### Added

- **Set how much space on-demand sharing keeps ready.** A new control in
  Storage settings caps the cache that "on demand" folders use to keep
  recently opened files instantly available — anywhere from 512 MB to
  3 GB, with 1 GB as the default.

#### Changed

- **Sharing a large folder is now instant.** Previewing a folder before
  you share it no longer reads through every file first, so a folder with
  tens of gigabytes opens right away instead of stalling. The scan runs
  in the background with live progress and a cancel button, and very
  large folders show a summary instead of an endless file list.

#### Fixed

- **No more flickering scrollbar while a mirrored folder downloads.** A
  folder syncing in the background could briefly show a stray scrollbar
  over empty space that flickered as files arrived. The folder view now
  stays put.
- **Smoother "on demand" sharing.** Serving a file on demand no longer
  freezes while someone is mirroring a large folder from you — recently
  served files are kept ready and disk is tidied up quietly in the
  background instead of all at once.
- **Folders shared from Windows now sync reliably.** On some Windows
  drives, a shared folder recorded its internal file paths in a malformed
  form that broke revealing files on disk, on-demand serving, and mirror
  file counts — and could expose the owner's local folder path to other
  members. Paths are now stored correctly, and existing shares repair
  themselves automatically the next time they sync.
- **Clearer wording in the Add Folder dialog.** When sharing your own
  folder, the preview no longer shows a confusing "already at the
  destination" count or a "file list hidden" note that didn't apply.


## v1.6.0
### 2026-05-31

#### Added

- **Share whole folders, not just individual files.** Pick a folder on
  your computer to share into a space and Mirall keeps it in sync — add,
  edit, or remove files and everyone in the space sees the change
  automatically. Subfolders come along too, so you can share an entire
  folder tree.
- **Browse and mirror folders others share.** Open a shared folder to
  see what's inside without downloading everything, or mirror it to a
  folder on your own computer to keep a live, always-up-to-date copy.
  Pause, resume, or stop mirroring whenever you want.
- **Share a folder "on demand".** A toggle in the Add Folder dialog
  offers a folder's files to the space but only sends each one when
  someone actually downloads it — handy for large folders you don't want
  to push up front.
- **The application menu is now on Windows and Linux,** not just macOS.
- **See and free up space per shared folder.** Storage settings now
  shows how much each shared folder is using, and Mirall reclaims unused
  space on its own when a space goes quiet.
- **Collapsible Storage and Members panels** in the space sidebar, so
  you can fold away what you're not using.

#### Changed

- **A more consistent interface throughout.** Status labels and colors, avatars, 
  buttons, corner radii, and spacing have been harmonized across every
  screen, so the whole app looks and behaves the same way wherever you are.
- **Quicker ways to get around.** Go back the way you would in a browser
  — your mouse's back button, a two-finger swipe on macOS, or
  Cmd/Ctrl+Left — and jump back to your spaces anytime from the logo or
  with Ctrl+H (Cmd+Shift+H on Mac).
- **Full keyboard and screen-reader support.** Every screen is now
  navigable by keyboard and works with assistive technology, and Mirall
  honors your system's reduced-motion preference.
- **A pending update now shows in the About screen,** and the update
  banner no longer covers up content while you work.
- **Fewer prompts when installing on Windows.** The installer no longer
  asks for "access your internet connection" and "home or work networks"
  permissions that Mirall never actually needed.

#### Fixed

- **Downloads no longer overwrite your existing files.** Saving a file
  whose name matched one already in your downloads folder used to
  replace it silently; downloads now land at a safe, non-colliding name.
- **Space members no longer go missing.** Joining a space with several
  people could occasionally drop someone from your member list until you
  reconnected — everyone now shows up reliably.
- **Windows updates now install reliably,** resolving a failure that
  could stop a detected update from applying.
- **Re-adding a file at the same path is handled correctly** instead of
  looking like a stuck, half-finished download.
- **No more flicker** when you drag a file over the drop zone.
- **A cancelled download no longer leaves a row stuck as "paused".**
- **The "on your device" indicator stays accurate** after a file is
  removed or re-shared.
- **The file list stays usable** when no peers are currently connected.


## v1.5.3
### 2026-05-20

#### Fixed

- **Windows updates now install.** New versions were detected and the
  update banner appeared, but on Windows the update never actually
  applied — restarting just showed the banner again. Updates now
  install correctly on quit and restart.
- **The version number shows immediately in the About screen** instead
  of briefly (or, on some machines, indefinitely) displaying a
  placeholder while it loaded.


## v1.5.2
### 2026-05-20

#### Fixed

- **Scrollbars match the app again.** They had reverted to the pale
  system default — a light bar on the dark interface. Scrollbars now
  follow the theme and render correctly across all platforms.


## v1.5.1
### 2026-05-19

#### Fixed

- **Invite code shown after creating a space now matches the one in the
  Invite dialog.** Right after you created a space, the code on the
  confirmation screen was still the old hex-with-dashes format and
  didn't carry the space name — pasting it into a friend's Mirall
  showed "Shared Space" instead of the real name. Both places now use
  the same envelope, so the name you picked travels with the invite.


## v1.5.0
### 2026-05-12

#### Added

- **Shareable invite links.** You can now send an invite as a clickable
  link that opens Mirall straight to the Join dialog, or as the plain
  code — pick the format in the Invite dialog. Invites also carry the
  space name, so the person joining sees what they're joining instead
  of a generic "Shared Space".
- **New Account page.** Click your avatar in the top-right to open a
  dedicated page that gathers your profile and your network connection
  in one place.
- **At-a-glance connection status.** Your avatar gains a soft pulsing
  ring when something's wrong — red if you've lost internet, amber
  while Mirall is trying to recover. No ring means you're connected
  and ready.
- **A heads-up when your connection drops.** A toast notification
  appears the moment Mirall notices a problem, with a "Show details"
  link that takes you straight to the new Network page.
- **Network page with friendly diagnostics.** Useful when a friend
  can't reach you or a transfer stalls. The page explains what Mirall
  sees about your connection, points out things worth checking (router,
  VPN, firewall) when something's off, and includes a "Reconnect"
  button to nudge things along.

#### Changed

- **Settings is now just app settings.** Profile editing and network
  status moved out of Settings into the new Account page (click your
  avatar). Settings keeps Appearance, General, Notifications, Storage,
  and About.

#### Fixed

- **No more empty files from dropped folders.** Dragging a folder into
  a space used to silently create an empty file with the folder's name
  — folder uploads aren't supported yet. Mirall now recognises the
  folder and shows a clear message asking you to pick individual files
  instead.


## v1.4.0
### 2026-05-09

#### Added

- **Mirall now lives in your menu bar (macOS) or system tray
  (Windows / Linux).** Closing the window no longer shuts the app down —
  peers stay connected, transfers keep going, and notifications still
  arrive. Click the tray icon to bring the window back. The new
  Settings → General page lets you opt out of background mode, or opt
  in to "Launch at login" so Mirall starts quietly with your computer.
- **Keyboard shortcuts and a command palette.** Press ⌘K (Ctrl-K) for
  a search-style command palette that jumps to any space or runs any
  action. Press ⌘/ (Ctrl-/) for the full shortcut list. The most
  useful ones: new space (⌘N), join space (⌘J), add files to the
  current space (⌘U), open Settings (⌘,), confirm any dialog
  (⌘Enter).

#### Changed

- **Settings reorganized.** Theme, display size, and language now live
  together under a new Appearance page. Background-mode and Launch at
  login are grouped under General. The main Settings screen is just
  your profile plus a tidy list of sub-pages — same controls, less
  noise.

#### Fixed

- **No more duplicate "online" notifications.** When a peer's connection
  briefly dropped and came back — closing your laptop lid, a flaky
  network, a Wi-Fi handoff — Mirall could fire a fresh "X is online"
  toast every time, sometimes several in a row. 
  Now this should not happen anymore
- **No more white flash when resizing the window.** Fast OS-driven
  resizes used to briefly paint blank pixels along the edges. The
  window background now tracks your chosen theme, so resizes stay
  seamless in both light and dark mode.


## v1.3.1
### 2026-05-07

#### Fixed

- **More reliable first launch.** Sometimes the first time you opened
  Mirall after installing or updating, the window could come up blank
  or stuck on the loading screen, and your spaces wouldn't connect.
  Mirall now starts up cleanly even while a newer version is being
  fetched in the background.
- **Smoother updates on Windows and Linux.** When a new version is
  ready, Mirall now installs it quietly in the background while you
  keep working. The next time you quit and reopen, you're already on
  the new version — no more update banner that sticks around after
  restart.
- **A11y** The 'Downloading' status pill was really hard to read with
  the light theme enabled. Now we meet again the WCAG contrast ration
  requirements and it also looks good again.


## v1.3.0
### 2026-05-07

#### Added

- **Choose where downloads go.** Storage settings has a new "Download
  folder" entry at the top. Pick any folder via the native folder picker
  and every download from every space lands there from then on. Defaults
  to your OS Downloads folder; the choice persists across restarts.
- **Clear peer cache (per space).** A new kebab menu on each row in
  Storage settings → Active Spaces lets you drop locally-cached content
  from peers in just that space, without leaving it. Your own published
  files stay; you can re-download anything from peers any time they're
  online.
- **Notifications when a peer removes a shared file.** If the owner
  deletes a file from their drive while you're downloading it — or while
  you're paused waiting for them to come back online — Mirall now tells
  you what happened ("File no longer shared by owner") and frees the
  partial. Previously the transfer would just hang or fail silently.


#### Changed

- **Honest per-space storage figures.** Storage settings now counts
  files you've downloaded from peers against the space they belong to,
  instead of lumping them into "Other". The `Cache:` line and `% of
  total` for each space reflect what that space is actually using on
  disk.
- **Atomic downloads.** In-progress downloads write to a hidden
  `.partial` file and rename to the final name only on completion. An
  interrupted transfer can't leave a half-written file in your Downloads
  folder.


#### Fixed

- Transfer-failed notifications now show a translated reason instead of
  leaking the raw `TRANSFER_*` error code into the toast.


## v1.2.0
### 2026-05-06

#### Added

- **"What's new" modal.** After an update, Mirall shows you what
  changed since the version you were last running. The full history 
  is also available any time from Settings → About → What's new.
- **Italian interface.** Added Italian translations alongside German,
  English, French, and Spanish.
- **Zoom levels.** Pick between Compact, Cozy, Default, and Spacious
  under Settings → Appearance, or step through any size with Cmd/Ctrl
  +, −, and 0. Your choice persists across restarts.


#### Changed

- Refreshed the light and dark themes — warmer per-space colors, a more
  consistent palette across settings, and better legibility for body and
  accent text in dark mode.


#### Fixed

- Linux: the AppImage stays executable after an automatic update, so it
  launches normally without a manual `chmod +x` first.


## v1.1.4
### 2026-05-05

#### Changed

- Updates no longer restart the app on their own. A staged update is applied
  the next time you quit Mirall yourself, so restarts happen on your schedule.


## v1.1.3
### 2026-05-04

#### Fixed

- A flapping connection no longer fires a stream of online/offline toasts —
  notifications are now deduplicated per peer.


## v1.1.2
### 2026-05-04

#### Fixed

- Leaving a space now propagates to the rest of the mesh, so other members
  see the change without having to restart their app.


## v1.1.1
### 2026-05-03

#### Fixed

- Windows: Mirall relaunches automatically after an update. Previously you
  had to reopen it from the Start menu after every update.
- macOS: fixed a blank screen that could appear after an update was applied.
- About screen: the build identifier next to the version no longer always
  reads "(0.0)" — it reflects the live update channel.


## v1.1.0
### 2026-05-03

#### Added

- **Desktop notifications.** Mirall surfaces incoming files and space
  activity through your operating system's notification center.
- **French and Spanish interface.** Added French and Spanish translations
  alongside German and English.
- Styled scrollbars in the space and file lists, matching Mirall's visual
  language instead of the platform default.
- Progress feedback while leaving a space — the action used to look
  unresponsive while cleanup was in flight.

#### Changed

- Text selection is disabled app-wide so the UI feels native. Anywhere a
  value used to be copyable by selecting it — invite codes, space IDs —
  now has a dedicated copy button.

#### Fixed

- **Screen reader support.** Icon-only buttons and clickable rows now
  expose proper accessible names; back buttons on inner screens are
  labelled.
- Notifications without an explicit icon now show the Mirall icon instead
  of a generic placeholder.


## v1.0.4
### 2026-05-02

#### Fixed

- Windows: removed the blue accent ring Windows draws around Mirall's
  taskbar icon when the window is active.


## v1.0.3
### 2026-05-02

#### Fixed

- Windows: refreshed app icon (no more generic default icon); icon refresh
  across all platforms.


## v1.0.2
### 2026-05-01

#### Fixed

- Linux: the AppImage now integrates correctly with your desktop on first
  launch — entry in the app menu, icons in the system tray.


## v1.0.1
### 2026-04-30

#### Added

- **German interface.** Mirall ships with German translations alongside
  English. Your OS locale is detected automatically on first run; you can
  override it under Settings → General → Sprache.

#### Fixed

- The file list now refreshes when a peer who was sharing files
  disconnects. Affected files transition to "Owner offline" instead of
  staying "Available" with a download button that did nothing.
- Windows: the update banner now appears as expected when a new build is
  available. It was silently dormant before.
- Storage settings: replaced the misleading per-space progress bars with
  a clear Cache / Metadata / share-of-total breakdown, plus an "Other" row
  that surfaces unreferenced cache. Per-space figures are flagged as
  estimates. The space sidebar card is renamed from "Space Storage" to
  "File Storage".


## v1.0.0
### 2026-04-29

Initial public release.

#### Added

- Peer-to-peer file sharing. Your files travel directly between you and
  the people you share with — there's no central server in the middle.
- **Spaces.** Group your shared files into named collections, each with
  its own membership and invite codes. Members see only what's shared
  with them.
- **Built-in updates.** Mirall checks for new versions on its own and
  applies them automatically — no manual download, no reinstall.
- Onboarding flow on first run for choosing a display name and avatar.
- Available for macOS, Windows, and Linux.
