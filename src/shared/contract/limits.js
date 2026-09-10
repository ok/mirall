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
