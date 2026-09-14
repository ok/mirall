// Which folder acts the command palette offers, and under what label. No row is ever disabled:
//   wrong role     — absent (Mirror on a folder you own is meaningless, not blocked).
//   toggle state   — never gated; the LABEL swings (a folder that is not syncing offers Resume).
//   work in flight — not modelled; the acts it blocks (Delete, Unmount) stay out of the palette.
// Every label carries the folder name: the palette is one flat list with no group headings, so the
// name is what scopes a row to this folder rather than the space, and makes the name a search term.

export function deriveFolderCommands(input) {
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
