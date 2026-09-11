// The stalled/healthy rule for a mirror loop. runMaterializeTick serialises passes per mount by
// handing every later tick the in-flight promise, so a pass that never settles wedges the mount
// permanently while the interval keeps firing.
import { stallVerdict } from '../core/stall-verdict.js'

// test seam
export const STALL_FACTOR = 20

export function mirrorVerdict(liveness, { now, pollIntervalMs, stallFactor = STALL_FACTOR }) {
  return stallVerdict(liveness, { now, windowMs: pollIntervalMs * stallFactor })
}
