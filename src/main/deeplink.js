// Parses mirall:// deep links into actions for the renderer: mirall://join/<invite-code> (or ?code=),
// whose invite must decode as a valid envelope, and mirall://license/a/<code>, an organization's
// activation link, recognized only on a channel that pins signing keys. Main checks a license code's
// shape only; the worker decodes it and verifies what it points at. The https web form of a link
// (docs/web-links/) is never claimed by the app: its page hands the payload
// here as mirall://join/<code>, and a pasted one is peeled by extractInviteCode.

// src/shared/contract/invite-envelope.js is ESM; src/main is CJS. Load it once via
// dynamic import at module evaluation time. parseDeepLink awaits readiness,
// so callers never see the partially-initialised state.
const ready = Promise.all([import('../shared/contract/invite-envelope.js'), import('../shared/contract/activation-syntax.js'), import('../shared/contract/managed-trust.js')])

async function parseDeepLink(input, { channel = 'prod' } = {}) {
  if (typeof input !== 'string') return null
  let url
  try { url = new URL(input) } catch { return null }
  if (url.protocol !== 'mirall:') return null
  const [{ decodeInvite }, activation, trust] = await ready
  if (url.hostname.toLowerCase() === activation.ACTIVATION_SCHEME_HOST) {
    if (!trust.hasManagedTrust(channel)) return null
    const code = activation.extractActivationCode(input)
    return code && activation.looksLikeActivationCode(code) ? { kind: 'license', code } : null
  }
  if (url.hostname !== 'join') return null

  // Trailing slashes too — mirrors src/shared/invite-envelope.js.
  const fromPath = url.pathname.replace(/^\/+|\/+$/g, '')
  const fromQuery = url.searchParams.get('code') ?? ''
  let raw = (fromPath || fromQuery).trim()
  if (!raw) return null
  try { raw = decodeURIComponent(raw) } catch { return null }

  const decoded = decodeInvite(raw)
  if (!decoded) return null

  const out = { kind: 'join', code: raw }
  if (decoded.v === 1 && decoded.name) out.name = decoded.name
  return out
}

module.exports = { parseDeepLink }
