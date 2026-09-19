// Numeric bounds both sides must agree on: the single declaration each side imports.
export const AVATAR_MAX_BYTES = 256 * 1024

// The display-name cap applied to a profile name and to the name carried in an invite envelope.
export const NAME_MAX = 80

// Room reserved in a membership:request frame for everything that is not the avatar. The frame is
// judged by peerFrameMaxBytes on the far side BEFORE it is parsed, so an avatar that overflows the
// budget makes the whole join request vanish unparsed. Worst case measured at 672 chars / 752 bytes:
// a NAME_MAX display name taken as multi-byte, hex64 profileKey/spaceTopic/inviteId/signerKey/
// signerNs and the hex128 ed25519 binding signature. 1024 keeps 36% of margin over that, so a new
// short field does not silently eat into the picture.
export const JOIN_REQUEST_FRAME_OVERHEAD = 1024

// The worker's NDJSON reader accumulates bytes until a newline. Uncapped, a sender that never
// terminates a frame grows worker memory without limit. Both sides must agree on this one: it is
// the largest frame a sender may put on the pipe, not just what the reader happens to tolerate.
// 1 MB is >2x the largest legitimate inbound frame — a profile update carrying a base64 avatar,
// AVATAR_MAX_BYTES inflated 4/3 plus JSON escaping. Deliberately NOT main's MAIN_REQUEST_MAX_LINE
// (64 KB): that gate guards the opposite direction (keeping a multi-MB worker->renderer response
// off main's UI thread) and would reject every avatar update.
export const IPC_MAX_FRAME_BYTES = 1024 * 1024

// The retention presets the Activity Log settings screen offers. The worker validates whatever it
// receives, so a divergence would degrade the picker, never the stored value — one declaration.
export const RETENTION_CHOICES = Object.freeze([30, 90, 365])

// How long a DHT that has not become ready counts as still coming up rather than unreachable. Both
// sides judge it: the worker's verdict and the renderer's connection pill must not disagree about
// when "connecting" becomes "offline".
export const DHT_FAILURE_MS = 45000

// The window cannot be made smaller than this. Main enforces it on the BrowserWindow and the
// renderer refuses to persist bounds below it, so a divergence would save a size that main then
// silently refuses to restore.
export const MIN_WINDOW_WIDTH = 900
export const MIN_WINDOW_HEIGHT = 870

// Boundary caps on request strings. NOT the domain limits: NAME_MAX truncates a display name to 80
// deep in the data layer, and that stays there, because truncating and refusing are different
// behaviours with different consequences for the user. These sit far above any domain rule and
// exist only so a string no honest caller sends is refused before a handler allocates around it.
// IPC_MAX_FRAME_BYTES is the only bound above them.
export const ARG_MAX = Object.freeze({
  name: 1024,      // display names, space and share names, icons
  key: 256,        // hex public keys, transfer ids, preview ids
  text: 4096,      // search strings, cursors, invite codes, free text
  path: 32768,     // the Windows long-path ceiling
})
