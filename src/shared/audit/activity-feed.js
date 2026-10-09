// The notifiable kinds, pushed to the renderer as event:activity the moment they are recorded. The
// push is the notification, the row is the log: the push does not wait on the log being open,
// enabled or within its rate budget. Imports core/ and its audit/ siblings only, like audit-log.js.
import { createLogger } from '../core/logger.js'
import { buildRecord } from './audit-record.js'
import { NOTIFIABLE_KINDS } from '../contract/audit-kinds.js'

const log = createLogger('activity-feed')

let emit = null

export function setActivityEmitter(fn) {
  emit = fn
}

// Whether a row of this kind is pushed: a caller that remembers "already reported" counts the push.
export function isAnnounced(kind) {
  return !!emit && NOTIFIABLE_KINDS.includes(kind)
}

// The same normalization a stored row gets, so the push and the log can never name a party
// differently. Never throws into the caller: a malformed row is a lost notification, not a failed act.
export function announceActivity(kind, fields) {
  if (!isAnnounced(kind)) return
  try {
    const ts = Date.now()
    const { actor, space, target, subject } = buildRecord({ ...fields, kind, seq: 0, ts })
    emit({ kind, ts, actor, space, target, subject })
  } catch (err) {
    log.warn('activity not announced:', kind, '-', err.message)
  }
}
