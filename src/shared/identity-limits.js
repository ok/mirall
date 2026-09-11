// Clamp/sanitize rules for peer-supplied identity fields (display name, avatar),
// shared by every worker ingest path.

// 256 KB data-URI string length. Tunable per-ingest via runtime-config getResourceCaps().avatarMaxBytes;
// this is the production default. The renderer reads the same constant from contract/limits.js.
import { AVATAR_MAX_BYTES, NAME_MAX } from './contract/limits.js'
export { AVATAR_MAX_BYTES }

const DATA_IMAGE = /^data:image\/(png|jpe?g|webp|gif);base64,/i

export function clampDisplayName(name) {
  if (typeof name !== 'string' || name.length === 0) return 'Unknown'
  return name.slice(0, NAME_MAX)
}

// Returns the avatar iff it is a well-formed image data URI within maxBytes, else null (treated
// everywhere as "no avatar"). maxBytes === 0 disables the size bound; the format check always applies.
export function sanitizeAvatar(value, maxBytes = AVATAR_MAX_BYTES) {
  if (typeof value !== 'string' || value.length === 0) return null
  if (!DATA_IMAGE.test(value)) return null
  if (maxBytes && value.length > maxBytes) return null
  return value
}
