// The decode half of mirall-publisher's src/layout.ts: the org drive is a Hyperbee whose entry
// bundles\0<profileId> holds that profile's latest sealed bundle. The publisher's
// drive-entry-v1.json pins the bytes.
import c from 'compact-encoding'

export const BUNDLES_SUB = 'bundles'
const DRIVE_ENTRY_VERSION = 1
const MAX_BUNDLE_BYTES = 1024 * 1024

export function decodeDriveEntry(value) {
  if (!value) return null
  try {
    const state = c.state(0, value.byteLength, value)
    if (c.uint.decode(state) !== DRIVE_ENTRY_VERSION) return null
    const seq = c.uint.decode(state)
    const payloadSha256 = c.fixed32.decode(state)
    const profileVersionId = c.string.decode(state)
    const issuedAt = c.uint.decode(state)
    const bundle = c.buffer.decode(state)
    if (state.start !== state.end) return null
    if (!bundle || bundle.byteLength === 0 || bundle.byteLength > MAX_BUNDLE_BYTES) return null
    return { seq, payloadSha256, profileVersionId, issuedAt, bundle }
  } catch {
    return null
  }
}
