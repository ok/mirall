// Builds the durable audit record. Pure — no store, no clock — so the shape is testable
// without a Corestore.
//
// The governing rule is ZERO JOINS AT RENDER TIME: everything the viewer displays or searches
// must be in the row itself. Live state cannot be joined against — leaving a space deletes its
// record, and a peer's name needs that peer online or replicated — so a row holding only ids
// would render raw hex forever. Hence a name snapshot on every participant, taken at write time.
import { isKnownKind, categoryOf, tierOf } from '../contract/audit-kinds.js'

export const SCHEMA_VERSION = 1

const NAME_MAX = 80
const SEARCH_MAX = 300
const CODE_MAX = 64
const OUTCOMES = ['ok', 'denied', 'error']

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

function normalizeTarget(target) {
  if (!target) return null
  return { kind: target.kind || null, id: target.id || null, name: clampName(target.name) }
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
  outcome = 'ok',
  code = null,
  device = null,
}) {
  if (!isKnownKind(kind)) throw new Error('audit: unknown kind ' + kind)
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
    outcome: OUTCOMES.includes(outcome) ? outcome : 'ok',
    code: typeof code === 'string' && code ? code.slice(0, CODE_MAX) : null,
    device: device || null,
    actor: a,
    space: s,
    target: t,
    subject: subject && typeof subject === 'object' ? subject : null,
    search: buildSearch(a, s, t),
  }
}
