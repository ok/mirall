// Pure detection of macOS "promised-file" temp locations — no I/O, no bare-*
// imports, so it stays unit-testable under Node (brittle-node).
//
// When you drag an item that isn't a saved file yet (a screenshot's floating
// thumbnail, a Photo Booth capture, an unsaved document), macOS doesn't hand us
// a real file — it materializes the drag through an NSFilePromise into a
// per-session temporary location and gives us that path. Those files vanish as
// soon as the source app finishes its drag, so a share built on one ends up
// pointing at nothing (and "Open in folder" falls back to an empty Downloads).
// We must reject them at publish time.
//
// The materialized paths carry distinctive, locale-independent markers. We match
// on those rather than on the temp directory as a whole, so genuine files that
// merely live under /tmp (and the test harness's own os.tmpdir() scratch dirs)
// are not swept up.
const EPHEMERAL_MARKERS = [
  '/temporaryitems/',
  '/cleanup at startup/',
  '(a document being saved by',
]

export function isEphemeralSourcePath(filePath) {
  if (!filePath) return false
  const norm = String(filePath).replace(/\\/g, '/').toLowerCase()
  return EPHEMERAL_MARKERS.some((marker) => norm.includes(marker))
}
