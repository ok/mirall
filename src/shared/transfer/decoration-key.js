// Decoration-map key for a folder-share row on the 'transfer' channel. Loose rows key by their
// drive path ('/'+relPath); share rows need the shareId axis so two shares with a same-named file
// can't mix bytes. Kept in sync with src/renderer/decoration-key.js (the renderer can't import
// worker code); test/unit/decoration-key.test.js asserts the two agree.
export function shareDecoKey(shareId, relPath) {
  return shareId + ':' + relPath
}
