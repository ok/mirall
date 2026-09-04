// Decoration-map key for a folder-share row on the 'transfer' channel. Loose rows key by their
// drive path ('/'+relPath); share rows need the shareId axis so two shares with a same-named file
// can't mix bytes. The worker emits decoration frames under this key and the renderer looks them
// up with it, so both reach it from here rather than each building their own.
export function shareDecoKey(shareId, relPath) {
  return shareId + ':' + relPath
}
