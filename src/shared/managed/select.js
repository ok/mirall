// Which of a drive's bundles applies to this license key, and what of it this build applies. Pure:
// the sources hand in what they read, and the caller persists and publishes the result.
import b4a from 'b4a'
import { verifyBundle } from './verify.js'
import { acceptValue } from './catalog.js'

const uuidOf = (bytes) => {
  const hex = b4a.toString(bytes, 'hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function newest(verified) {
  return verified.reduce((best, next) => {
    if (!best) return next
    if (next.result.header.issuedAt !== best.result.header.issuedAt) return next.result.header.issuedAt > best.result.header.issuedAt ? next : best
    return next.profileId < best.profileId ? next : best
  }, null)
}

// The verified bundle with our wrap and the newest issuedAt wins (the lower profileId on a tie).
// Only locked values this build accepts are applied, as plain values; a refused value drops only its
// key. A bundle sealed for other license keys is silent, not a failure.
export function selectApplied(candidates, ctx) {
  const failures = []
  const verified = []
  for (const { profileId, bytes } of candidates) {
    const result = verifyBundle(bytes, ctx)
    if (result.ok) verified.push({ profileId, result })
    else if (result.failure !== 'not_for_this_key') failures.push({ profileId, failure: result.failure })
  }
  const chosen = newest(verified)
  if (!chosen) return { applied: null, refused: [], ignoredUnlocked: [], failures }
  const settings = {}
  const refused = []
  const ignoredUnlocked = []
  for (const [key, { value, locked }] of Object.entries(chosen.result.settings)) {
    if (!locked) ignoredUnlocked.push(key)
    else if (acceptValue(key, value)) settings[key] = value
    else refused.push(key)
  }
  const { header, organization, endpoints } = chosen.result
  return {
    applied: { issuedAt: header.issuedAt, profileVersionId: uuidOf(header.profileVersionId), organization, endpoints, settings },
    refused,
    ignoredUnlocked,
    failures,
  }
}
