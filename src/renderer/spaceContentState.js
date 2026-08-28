// What the space pane renders while its two list sources settle. A space's contents come from
// two independent reads — loose files (useFiles) and folder shares (useShares) — that resolve
// on their own schedules. "Is this space empty?" is therefore a two-source question: answering
// it from the faster source alone puts the "nothing shared yet" hero, docs card and all, over
// a space that demonstrably HAS content, for as long as the other read is still in flight.
// Absence of rows is only emptiness once both reads have settled.

export function showSpaceEmptyState ({ filesLoading, sharesLoading, filesError, fileCount, shareCount }) {
  if (filesLoading || sharesLoading) return false
  // A failed listing is unknown, not empty — the files section shows its own retry card.
  if (filesError) return false
  return fileCount === 0 && shareCount === 0
}

// The loading indicator covers the same window from the other side: files loading always shows
// it (under whatever folder cards already arrived), and a pane with nothing in it yet keeps it
// until the shares read settles too — otherwise the pane blanks between the two.
export function showSpaceLoading ({ filesLoading, sharesLoading, fileCount, shareCount }) {
  if (filesLoading) return true
  return sharesLoading && fileCount === 0 && shareCount === 0
}
