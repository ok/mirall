// Parses mirall:// deep links into actions for the renderer. Only
// mirall://join/<invite-code> (or ?code=) is recognized; the invite must
// decode as a valid envelope, so arbitrary OS-delivered URLs can't inject
// anything beyond a well-formed join request.

// src/shared/invite-envelope.js is ESM; src/main is CJS. Load it once via
// dynamic import at module evaluation time. parseDeepLink awaits readiness,
// so callers never see the partially-initialised state.
const ready = import('../shared/invite-envelope.js')

async function parseDeepLink(input) {
  if (typeof input !== 'string') return null
  let url
  try { url = new URL(input) } catch { return null }
  if (url.protocol !== 'mirall:') return null
  if (url.hostname !== 'join') return null

  // Trailing slashes too — mirrors src/shared/invite-envelope.js.
  const fromPath = url.pathname.replace(/^\/+|\/+$/g, '')
  const fromQuery = url.searchParams.get('code') ?? ''
  let raw = (fromPath || fromQuery).trim()
  if (!raw) return null
  try { raw = decodeURIComponent(raw) } catch { return null }

  const { decodeInvite } = await ready
  const decoded = decodeInvite(raw)
  if (!decoded) return null

  const out = { kind: 'join', code: raw }
  if (decoded.v === 1 && decoded.name) out.name = decoded.name
  return out
}

module.exports = { parseDeepLink }
