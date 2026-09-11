// Builds the durable audit record. Pure — no store, no clock — so the shape is testable
// without a Corestore.
//
// The governing rule is ZERO JOINS AT RENDER TIME: everything the viewer displays or searches
// must be in the row itself. Live state cannot be joined against — leaving a space deletes its
// record, and a peer's name needs that peer online or replicated — so a row holding only ids
// would render raw hex forever. Hence a name snapshot on every participant, taken at write time.
//
// buildRecord below IS the v1 row schema — every `audit-log` bee row is one of its results, and
// nothing else writes one. The renderer derives the vocabularies (category, outcome, actor type,
// target kind) from the contract, but still hand-writes the FIELD LIST in its types, so a field
// added here has to be added there too; bumping SCHEMA_VERSION without doing so leaves the two
// disagreeing with no gate between them.
import { isKnownKind, categoryOf, tierOf, ACTOR_TYPE, OUTCOME, OUTCOMES, TARGET_KINDS } from '../contract/audit-kinds.js'
import { NAME_MAX } from '../contract/limits.js'

// test seam
export const SCHEMA_VERSION = 1

// The participant shapes, built here or nowhere. Hand-written literals drifted: some omitted `key`
// and `name` entirely, peer-watch.js shadowed the worker's own spaceRef with a second copy, and the
// worker kept three of these as private functions no other caller could reach. A row's shape is not
// a per-site decision — normalizeActor and friends below are the only readers, and they expect
// exactly this.

// The key and name default to null because most producers do not know them; audit-log fills them
// from the live identity at write time and calls this with both.
export function selfActor(key = null, name = null) {
  return { type: ACTOR_TYPE.SELF, key: key ?? null, name: name ?? null }
}

// The name is resolved by the caller: it needs the live roster or the space record, which this
// module deliberately cannot reach.
export function peerActor(key, name) {
  return { type: ACTOR_TYPE.PEER, key: key ?? null, name: name ?? null }
}

export function systemActor() {
  return { type: ACTOR_TYPE.SYSTEM, key: null, name: null }
}

export function spaceRef(id, name) {
  return id ? { id, name: name ?? null } : null
}

export function targetRef(kind, id, name) {
  return { kind, id: id ?? null, name: name ?? null }
}

const SEARCH_MAX = 300
const CODE_MAX = 64

function clampName(value) {
  return typeof value === 'string' && value ? value.slice(0, NAME_MAX) : null
}

function normalizeActor(actor) {
  if (!actor) return null
  return { type: actor.type, key: actor.key || null, name: clampName(actor.name) }
}

function normalizeSpace(space) {
  if (!space || !space.id) return null
  return { id: space.id, name: clampName(space.name) }
}

// Refused rather than stored, exactly as an unknown kind or outcome is: the viewer groups and links
// on this field, so a spelling it does not know is a row that no filter can ever surface.
function normalizeTarget(target) {
  if (!target) return null
  if (!TARGET_KINDS.includes(target.kind)) throw new Error('audit: unknown target kind ' + target.kind)
  return { kind: target.kind, id: target.id || null, name: clampName(target.name) }
}

// Proper nouns only, deliberately language-independent. The kind is NOT included: the renderer
// resolves a typed term against its translated kind labels and passes the matches as a `kinds`
// filter, so search works in all five locales without storing localized text.
function buildSearch(actor, space, target) {
  return [actor?.name, space?.name, target?.name]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .slice(0, SEARCH_MAX)
}

export function buildRecord({
  seq,
  ts,
  tzOffset = 0,
  kind,
  actor = null,
  space = null,
  target = null,
  subject = null,
  outcome = OUTCOME.OK,
  code = null,
  device = null,
}) {
  if (!isKnownKind(kind)) throw new Error('audit: unknown kind ' + kind)
  if (!OUTCOMES.includes(outcome)) throw new Error('audit: unknown outcome ' + outcome)
  if (!Number.isInteger(seq) || seq < 0) throw new Error('audit: seq must be a non-negative integer')
  const a = normalizeActor(actor)
  const s = normalizeSpace(space)
  const t = normalizeTarget(target)
  return {
    v: SCHEMA_VERSION,
    seq,
    ts,
    tzOffset,
    kind,
    category: categoryOf(kind),
    tier: tierOf(kind),
    outcome,
    code: typeof code === 'string' && code ? code.slice(0, CODE_MAX) : null,
    device: device || null,
    actor: a,
    space: s,
    target: t,
    subject: subject && typeof subject === 'object' ? subject : null,
    search: buildSearch(a, s, t),
  }
}
