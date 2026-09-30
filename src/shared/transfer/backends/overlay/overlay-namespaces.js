// The overlay's local cores live under a fixed namespace, so they are found again on every boot.
// The '-e1' generation encrypts them at rest under an M-derived key; a store without a master
// secret stays on the plaintext one. A plaintext core can't be retro-encrypted, so the one-time
// migrateOverlayIndexToEncrypted copies the plaintext generation into the encrypted one.
export const OVERLAY_NAMESPACE = 'mirall-overlay'
export const OVERLAY_NAMESPACE_ENC = 'mirall-overlay-e1'
