// What the Folder tile's status pill says. Precedence, not a switch: a folder whose source is gone
// is "missing" even while a scan is queued, and a paused folder is "paused" even while rows still
// carry progress from the pass that was interrupted.
//
// `badge` is a BadgeStatus so the pill borrows its colours from statusBadge.js — the same five
// tokens the file rows use, so "paused" is the same yellow in the tile and in the row beneath it.
//
// No live region here. Every state worth announcing already has a strip above the listing, and a
// second announcement from the tile would read the same change twice.

export function deriveFolderStatus (input) {
  const { role, sourceMissing, fault, indexPaused, mirrorEnabled, indexing, mirrorSyncing } = input
  if (sourceMissing) return { labelKey: 'folder.statusMissing', badge: 'paused' }
  // Above both pauses, for the same reason the fault strip is: an auto-paused mirror is
  // enabled === false, so without this the tile calls a stopped folder "Paused".
  if (fault) return { labelKey: 'folder.statusFault', badge: 'error' }
  if (role === 'mine' && indexPaused) return { labelKey: 'folder.statusPaused', badge: 'paused' }
  if (role === 'mirrored' && mirrorEnabled === false) return { labelKey: 'folder.statusPaused', badge: 'paused' }
  if (role === 'mine' && indexing) return { labelKey: 'folder.statusAdding', badge: 'publishing' }
  if (role === 'mirrored' && mirrorSyncing) return { labelKey: 'folder.statusSyncing', badge: 'downloading' }
  if (role === 'browse') return { labelKey: 'folder.statusBrowseOnly', badge: 'available' }
  return { labelKey: 'folder.statusUpToDate', badge: 'on-device' }
}
