// Whether a mirror tick must walk, kept pure so the rule is asserted directly rather than through a
// live loop and a real catalog.
//
// The order is the safety argument: every branch that cannot prove nothing changed costs a walk.
// A skip is only ever authorised by a known version that matches a watermark a converged pass set.
export const DEFAULT_FULL_WALK_EVERY = 10

export function shouldWalk({ watermark = null, version = null, skipped = 0, fullWalkEvery = DEFAULT_FULL_WALK_EVERY } = {}) {
  if (watermark === null) return { walk: true, reason: 'no-watermark' }
  if (version === null) return { walk: true, reason: 'version-unknown' }
  if (version !== watermark) return { walk: true, reason: 'catalog-appended' }
  if (!(fullWalkEvery > 1)) return { walk: true, reason: 'backstop-disabled' }
  if (skipped + 1 >= fullWalkEvery) return { walk: true, reason: 'backstop' }
  return { walk: false, reason: null }
}
