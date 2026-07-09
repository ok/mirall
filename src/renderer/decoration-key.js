// Mirror of src/shared/transfer/decoration-key.js (the renderer can't import worker code); the
// worker emits folder-share decoration frames under this key, the renderer looks them up with it.
// test/unit/decoration-key.test.js asserts the two copies agree.
export function shareDecoKey(shareId, relPath) {
  return shareId + ':' + relPath
}
