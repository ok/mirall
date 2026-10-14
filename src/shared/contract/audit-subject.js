// The names and paths an audit row's subject puts on its second line. The renderer shows them and
// the query searches them, both from this one reading, so a row never shows a name its search
// cannot find. Names come before paths: a capped copy of the search text loses a path first.
/** @import { AuditEntry } from './responses.js' */

/** @param {string | number | boolean | null | undefined} value */
const text = (value) => (typeof value === 'string' && value ? value : null)

/** @param {string} kind @param {AuditEntry['subject'] | undefined} subject */
export function shownSubject(kind, subject) {
  /** @type {NonNullable<AuditEntry['subject']>} */
  const s = subject && typeof subject === 'object' ? subject : {}
  const relayed = kind === 'network.peer_relayed'
  return {
    folder: text(s.folder),
    relayLabel: relayed && s.via === 'own' ? text(s.label) : null,
    relayProvider: relayed && s.via !== 'own' ? text(s.provider) : null,
    previousRelay: kind === 'relay.replaced' ? text(s.previousLabel) ?? text(s.previous) : null,
    to: text(s.to),
    mountPath: text(s.mountPath),
  }
}
