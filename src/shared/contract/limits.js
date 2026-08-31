// Numeric bounds both sides must agree on. Each of these had two or three independent copies whose
// only guard was a "keep in sync" comment; this is the single declaration they now import.
export const AVATAR_MAX_BYTES = 256 * 1024

// The display-name cap applied to a profile name and to the name carried in an invite envelope.
export const NAME_MAX = 80

// The worker's NDJSON reader accumulates bytes until a newline. Uncapped, a sender that never
// terminates a frame grows worker memory without limit. Both sides must agree on this one: it is
// the largest frame a sender may put on the pipe, not just what the reader happens to tolerate.
// 1 MB is >2x the largest legitimate inbound frame — a profile update carrying a base64 avatar,
// AVATAR_MAX_BYTES inflated 4/3 plus JSON escaping. Deliberately NOT main's MAIN_REQUEST_MAX_LINE
// (64 KB): that gate guards the opposite direction (keeping a multi-MB worker->renderer response
// off main's UI thread) and would reject every avatar update.
export const IPC_MAX_FRAME_BYTES = 1024 * 1024
