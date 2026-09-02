// Which folder acts the command palette offers, and under what label. Unavailability splits three
// ways here, and none of the three wants a greyed-out row:
//   wrong role     — absent. "Mirror" on a folder you already own is not an act that is
//                    temporarily blocked, it is meaningless, and listing it teaches nothing.
//   toggle state   — never gated; the LABEL swings instead. A folder that is not syncing offers
//                    Resume, which is the act the user opened the palette for.
//   work in flight — not modelled at all. The acts it blocks (Delete, Unmount) are deliberately
//                    kept out of the palette, so no entry here ever needs a disabled state.
//
// The palette renders one flat ranked list with no group headings, so every label carries the
// folder name: it is the only thing marking these rows as scoped to the folder on screen rather
// than to the space beside it, and it is what makes the name itself a useful search term.

export function deriveFolderCommands (input) {
  const { role, paused, sourceMissing, canMirror } = input
  const isOwn = role === 'mine'
  const isBrowse = role === 'browse'
  return {
    open: { labelKey: 'shortcuts.folderOpen', available: !isBrowse && !sourceMissing },
    locate: { labelKey: 'shortcuts.folderLocate', available: isOwn && sourceMissing },
    toggleSync: {
      labelKey: paused ? 'shortcuts.folderResume' : 'shortcuts.folderPause',
      available: !isBrowse,
    },
    mirror: { labelKey: 'shortcuts.folderMirror', available: isBrowse && canMirror },
    edit: { labelKey: 'shortcuts.folderEdit', available: !isBrowse },
  }
}
