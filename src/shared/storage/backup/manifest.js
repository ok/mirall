// What a backup snapshot records per core: its key and role, the length, fork and tree hash it was
// captured at, how much of it was held from block 0, and the chain of ranges whose parts rebuild it.
// Every snapshot lists each core's whole chain, so restoring one reads that snapshot alone. A chain
// grows by one range per change and starts over from 0 when the core no longer extends what was
// captured (truncated, forked, or recreated under the same key), when blocks below the captured
// length arrived since (a peer's core filling in), or when it reaches MAX_CHAIN.

export const MANIFEST_VERSION = 1
export const MAX_CHAIN = 32

const HEX64 = /^[0-9a-f]{64}$/

// `extends` says whether the core's tree at prev.length still hashes to prev.treeHash.
export function deltaPlan(prev, now, { extends: continues = true } = {}) {
  if (now.length === 0) return { kind: 'skip' }
  const filledIn = prev && prev.contiguous < prev.length && now.contiguous > prev.contiguous
  if (!prev || !continues || filledIn || prev.fork !== now.fork || now.length < prev.length || prev.segments.length >= MAX_CHAIN) {
    return { kind: 'full', from: 0, to: now.length }
  }
  if (now.length === prev.length) return { kind: 'none' }
  return { kind: 'delta', from: prev.length, to: now.length }
}

export function nextCoreEntry(prev, now, plan, parts) {
  if (plan.kind === 'none') return { ...prev, role: now.role, name: now.name, spaceId: now.spaceId }
  const segment = { from: plan.from, to: plan.to, parts }
  return { ...now, segments: plan.kind === 'full' ? [segment] : [...prev.segments, segment] }
}

const isObject = (value) => value !== null && typeof value === 'object'

function coreProblem(core) {
  if (!isObject(core)) return 'a core entry is not an object'
  if (!HEX64.test(core.dk) || !HEX64.test(core.key)) return 'a core key is malformed'
  if (!HEX64.test(core.treeHash)) return `core ${core.dk.slice(0, 8)} has no tree hash`
  if (!Array.isArray(core.segments) || core.segments.length === 0) return `core ${core.dk.slice(0, 8)} has no ranges`
  let at = 0
  for (const segment of core.segments) {
    if (!isObject(segment)) return `core ${core.dk.slice(0, 8)} has a malformed range`
    if (segment.from !== at || segment.to <= segment.from) return `core ${core.dk.slice(0, 8)} has a gap or overlap at ${at}`
    if (!Array.isArray(segment.parts) || segment.parts.length === 0) return `core ${core.dk.slice(0, 8)} has a range with no parts`
    at = segment.to
  }
  if (at !== core.length) return `core ${core.dk.slice(0, 8)} ends at ${at}, not ${core.length}`
  return null
}

// The first thing wrong with a manifest, or null. Restore refuses a snapshot this does not pass.
export function validateManifest(manifest) {
  if (!manifest || manifest.v !== MANIFEST_VERSION || !Array.isArray(manifest.cores)) return 'not a backup manifest this version reads'
  const seen = new Set()
  for (const core of manifest.cores) {
    const problem = coreProblem(core)
    if (problem) return problem
    if (seen.has(core.dk)) return `core ${core.dk.slice(0, 8)} is listed twice`
    seen.add(core.dk)
  }
  return null
}
