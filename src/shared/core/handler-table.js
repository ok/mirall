import { REQUESTS } from '../contract/requests.js'

// Presence, primitive type and length only. Anything richer is the handler's business: this exists
// to stop a malformed payload reaching a handler body, not to re-implement the domain rules.
// spaceId, shareId and path are documentary names for a string check — they carry intent without
// asserting a format the boundary has not proven every caller satisfies.
function checkType (type, value, field) {
  switch (type) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : `${field} must be a number`
    case 'boolean':
      return typeof value === 'boolean' ? null : `${field} must be a boolean`
    case 'array':
      return Array.isArray(value) ? null : `${field} must be an array`
    case 'spaceId':
    case 'shareId':
    case 'path':
    case 'string':
      return typeof value === 'string' ? null : `${field} must be a string`
    default:
      // A type the validator does not know would otherwise validate NOTHING and say so to nobody.
      // Throwing makes a typo in a row a boot failure, which is where every other contract mistake
      // in this package surfaces.
      throw new Error(`unknown arg type in the contract: ${type} (field ${field})`)
  }
}

export function validateArgs (shape, msg) {
  for (const [field, rule] of Object.entries(shape)) {
    const value = msg[field]
    if (value === undefined || value === null) {
      if (rule.optional) continue
      return `missing required field: ${field}`
    }
    const bad = checkType(rule.type, value, field)
    if (bad) return bad
    if (rule.max != null && typeof value === 'string' && value.length > rule.max) {
      return `${field} exceeds ${rule.max} characters`
    }
  }
  return null
}

// A handler is a value with metadata rather than a closure in a script, so the router can read the
// request's shape without the entrypoint telling it. Registering a name the contract does not know
// throws at boot, which turns a typo into a startup failure instead of a 404 in the field.
export function createHandlerTable ({ requests = REQUESTS } = {}) {
  const entries = new Map()
  return {
    register (name, fn) {
      const spec = requests[name]
      if (!spec) throw new Error(`handler for a request the contract does not declare: ${name}`)
      if (entries.has(name)) throw new Error(`duplicate handler: ${name}`)
      entries.set(name, { name, fn, spec })
      return this
    },
    get: (name) => entries.get(name) ?? null,
    has: (name) => entries.has(name),
    names: () => [...entries.keys()],
    size: () => entries.size,
  }
}
