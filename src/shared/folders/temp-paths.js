// macOS materializes a dragged not-yet-saved item (a screenshot's floating thumbnail, an unsaved
// document) through an NSFilePromise into a per-session temp path that vanishes when the drag ends,
// so a share built on one points at nothing. Match the distinctive, locale-independent markers
// rather than the temp directory as a whole, so real files under /tmp (and the test harness's own
// os.tmpdir() scratch dirs) survive.
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
