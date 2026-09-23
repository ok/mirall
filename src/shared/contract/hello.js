// Whether a client's introduction may be accepted: its wire version, what it says it is, and where
// it claims to have read to. Version first, because a frame from a different wire must not have its
// other fields interpreted at all. Separate from the router so the decision is testable without a
// pipe, exactly as protocol-compat.js is.
import { checkProtocolCompatibility } from './protocol-compat.js'
import { CLIENT_KINDS } from './ipc-frames.js'

/** @import { ProtocolRefusal } from './protocol-compat.js' */
/** @import { ClientKind } from './ipc-frames.js' */

/** @typedef {'bad-client' | 'bad-cursor'} HelloRefusal */
/** @typedef {ProtocolRefusal | HelloRefusal} Refusal */
/** @typedef {{ epoch: string | null, since: number }} HelloCursor */
/**
 * @typedef {{ ok: true, kind: ClientKind, name: string, version: string, cursor: HelloCursor | null }
 *   | { ok: false, reason: Refusal, theirs: number | null, ours: number }} HelloVerdict
 */

// The declared name and version are logged, so they are bounded at the boundary rather than trusted.
const MAX_TEXT = 64

/** @param {unknown} value @returns {string} */
function text(value) {
  return typeof value === 'string' ? value.slice(0, MAX_TEXT) : ''
}

// A malformed cursor is REFUSED rather than ignored. A client that sends one and is silently
// treated as brand new believes it was caught up, and will never ask again for what it missed.
/** @param {unknown} value @returns {'absent' | 'bad' | HelloCursor} */
function readCursor(value) {
  if (value == null) return 'absent'
  if (typeof value !== 'object') return 'bad'
  const cursor = /** @type {{ epoch?: unknown, since?: unknown }} */ (value)
  if (cursor.epoch !== null && typeof cursor.epoch !== 'string') return 'bad'
  if (!Number.isInteger(cursor.since) || /** @type {number} */ (cursor.since) < 0) return 'bad'
  return {
    epoch: /** @type {string | null} */ (cursor.epoch),
    since: /** @type {number} */ (cursor.since),
  }
}

/** @param {unknown} frame @returns {HelloVerdict} */
export function checkHello(frame) {
  const compat = checkProtocolCompatibility(/** @type {{ protocolVersion?: unknown }} */ (frame))
  if (!compat.ok) {
    return {
      ok: false,
      reason: /** @type {ProtocolRefusal} */ (compat.reason),
      theirs: compat.theirs,
      ours: compat.ours,
    }
  }

  const declared = /** @type {{ client?: { kind?: unknown, name?: unknown, version?: unknown } } | null} */ (frame)?.client
  const kind = declared?.kind
  if (typeof kind !== 'string' || !CLIENT_KINDS.includes(/** @type {ClientKind} */ (kind))) {
    return { ok: false, reason: 'bad-client', theirs: compat.theirs, ours: compat.ours }
  }

  const cursor = readCursor(/** @type {{ cursor?: unknown } | null} */ (frame)?.cursor)
  if (cursor === 'bad') return { ok: false, reason: 'bad-cursor', theirs: compat.theirs, ours: compat.ours }

  return {
    ok: true,
    kind: /** @type {ClientKind} */ (kind),
    name: text(declared?.name),
    version: text(declared?.version),
    cursor: cursor === 'absent' ? null : cursor,
  }
}

// Why a connection was refused, in one sentence for the log and the error the host sees. Every
// refusal an introduction can earn is spelled here, the wire's and this frame's alike, because the
// client is told once and has only that sentence to go on.
/** @param {{ reason: Refusal | null, theirs: number | null, ours: number }} verdict */
export function refusalMessage({ reason, theirs, ours }) {
  if (reason === 'no-version') return `the host sent no protocol version; this worker speaks v${ours}`
  if (reason === 'bad-client') return 'the client did not say what it is'
  if (reason === 'bad-cursor') return 'the client sent a cursor this worker cannot read'
  return `protocol mismatch: the host speaks v${theirs}, this worker speaks v${ours}`
}
