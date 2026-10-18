// The Activity Log rows for an organization's configuration: connecting, a change to what it locks,
// and leaving. The organization is the target, so its name is what the sentence and search read; the
// subject lists the locked keys, never their values or a resolved path. Pure.
import { TARGET_KIND } from '../contract/audit-kinds.js'
import { selfActor, systemActor, targetRef } from './audit-record.js'

const target = (organization) => targetRef(TARGET_KIND.ORGANIZATION, null, organization.name)
const keysOf = (applied) => Object.keys(applied.settings).sort().join(',')

export const managedJoinedRow = (applied) => ({ kind: 'managed.joined', row: { actor: selfActor(), target: target(applied.organization), subject: { keys: keysOf(applied) } } })

export const managedLeftRow = (organization) => ({ kind: 'managed.left', row: { actor: selfActor(), target: target(organization), subject: {} } })

const sameSettings = (a, b) => keysOf({ settings: a }) === keysOf({ settings: b }) && Object.keys(a).every((key) => a[key] === b[key])

export function managedChangedRow(before, after) {
  const same = before && sameSettings(before.settings, after.settings) && before.organization.name === after.organization.name
  return same ? null : { kind: 'managed.changed', row: { actor: systemActor(), target: target(after.organization), subject: { keys: keysOf(after) } } }
}
