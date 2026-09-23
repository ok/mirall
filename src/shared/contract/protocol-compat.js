// Whether two ends of the worker pipe speak the same wire. The bootstrap frame carries the sender's
// version and the window it accepts; this decides, before any other field is read, whether to
// proceed or refuse. Separate from the router so the decision is testable without a pipe.
import { IPC_PROTOCOL_VERSION, IPC_PROTOCOL_MIN_SUPPORTED } from './ipc-frames.js'

/** @typedef {'no-version' | 'too-old' | 'we-are-newer' | 'we-are-older'} ProtocolRefusal */
/** @typedef {{ ok: boolean, reason: ProtocolRefusal | null, theirs: number | null, ours: number }} ProtocolVerdict */

// Compatible when each side's version falls inside the other's accepted window. A frame that
// carries no version at all is a host from before the field existed: refused, not assumed
// compatible, because "assume compatible" is exactly the silent degradation this guard removes.
/**
 * @param {{ protocolVersion?: unknown, protocolMin?: unknown, protocolMax?: unknown } | null | undefined} frame
 * @param {{ version?: number, min?: number }} [self]
 * @returns {ProtocolVerdict}
 */
export function checkProtocolCompatibility(frame, {
  version = IPC_PROTOCOL_VERSION,
  min = IPC_PROTOCOL_MIN_SUPPORTED,
} = {}) {
  const theirs = frame?.protocolVersion
  if (!Number.isInteger(theirs)) return { ok: false, reason: 'no-version', theirs: null, ours: version }
  const them = /** @type {number} */ (theirs)
  if (them < min) return { ok: false, reason: 'too-old', theirs: them, ours: version }
  const theirMax = Number.isInteger(frame?.protocolMax) ? /** @type {number} */ (frame?.protocolMax) : them
  const theirMin = Number.isInteger(frame?.protocolMin) ? /** @type {number} */ (frame?.protocolMin) : them
  // Our FLOOR against their ceiling, not our current version: a build that speaks v2 and still
  // supports v1 must accept a v1 host. Comparing `version` here would make MIN_SUPPORTED unable to
  // widen anything, which is the only thing it exists to do.
  if (min > theirMax) return { ok: false, reason: 'we-are-newer', theirs: them, ours: version }
  if (version < theirMin) return { ok: false, reason: 'we-are-older', theirs: them, ours: version }
  return { ok: true, reason: null, theirs: them, ours: version }
}
