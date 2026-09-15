// Key layout of the `audit-log` bee. Both indexes are pure appends — no read-modify-write on the
// hot path.
//   evt/<seq padded>          the record. Zero-padded so lexicographic order is numeric order,
//                             which makes one reverse range scan both the newest-first listing
//                             and the pagination cursor.
//   by-space/<spaceId>/<seq>  seq. Serves the space filter without a full scan.
//   by-device/<seq>           seq. The same index for rows with NO space (device connectivity):
//                             an outage belongs in a space's timeline but is not attributable TO
//                             the space, hence a second index.
//   seen/<beeKeyHex>          the version of a peer's bee already turned into rows.
//   pstate/<subject>          'on' for the last RECORDED state of a peer subject; 'off' is the
//                             absence of the key.
//   nstate                    the last RECORDED device connectivity episode; healthy is the
//                             absence of the key.
//   config                    retention settings.
import { prefixRange } from '../core/bee-keys.js'

const SEQ_WIDTH = 16

export const EVT = 'evt/'
export const BY_SPACE = 'by-space/'
export const BY_DEVICE = 'by-device/'
export const SEEN = 'seen/'
export const PSTATE = 'pstate/'
export const NSTATE = 'nstate'
export const CONFIG_KEY = 'config'

export const pad = (seq) => String(seq).padStart(SEQ_WIDTH, '0')
export const evtKey = (seq) => EVT + pad(seq)
export const spaceKey = (spaceId, seq) => BY_SPACE + spaceId + '/' + pad(seq)
export const deviceKey = (seq) => BY_DEVICE + pad(seq)
export const seqOf = (key) => Number(key.slice(EVT.length))

// The one index entry a record has: by space when it names one, by device otherwise.
export function indexKeyOf(rec) {
  return rec.space?.id ? spaceKey(rec.space.id, rec.seq) : deviceKey(rec.seq)
}

// Every key under `prefix`, or only those whose seq is below `below`.
export function indexRange(prefix, below = null) {
  return below == null ? prefixRange(prefix) : { gte: prefix, lt: prefix + pad(below) }
}

export function evtRange(below = null) {
  return indexRange(EVT, below)
}
