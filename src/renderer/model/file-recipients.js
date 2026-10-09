// Who has one of our files, derived for its row: the collapsed "N of M have it" and the expanded list
// grouped by what each member's state asks of the owner. Counted against the space's admitted members
// other than the file's owner, so a member who joins later raises the total — they do not have it.
// Plain JS so it unit-tests in the Node runner.
/** @import { FileRecipient, MirrorParticipant, SpaceMember } from '../../shared/contract/responses.js' */

// How many recent recipients the collapsed row shows by face; the text carries the rest.
export const RECENT_FACES = 3

/**
 * @typedef {{ holders: SpaceMember[], count: number, total: number, everyone: boolean }} RecipientSummary
 * @typedef {{ member: SpaceMember, ts: number }} HolderRow
 * @typedef {{ member: SpaceMember, earlier: boolean }} MissingRow
 */

/** @param {SpaceMember[]} members @param {string} ownerKey */
function audience(members, ownerKey) {
  return members.filter((m) => m.publicKey !== ownerKey && m.status !== 'pending')
}

/**
 * The members holding the current version, newest first.
 * @param {FileRecipient[]} recipients @param {string} contentHash @param {Map<string, SpaceMember>} byKey
 * @returns {HolderRow[]}
 */
function currentHolders(recipients, contentHash, byKey) {
  const rows = []
  for (const r of recipients) {
    const member = byKey.get(r.personKey)
    if (member && r.contentHash === contentHash) rows.push({ member, ts: r.ts })
  }
  return rows.sort((a, b) => b.ts - a.ts)
}

/**
 * Null while nobody holds the current version: a row with no recipient shows nothing.
 * @param {{ recipients: FileRecipient[], contentHash: string, members: SpaceMember[], ownerKey: string }} input
 * @returns {RecipientSummary | null}
 */
export function recipientSummary({ recipients, contentHash, members, ownerKey }) {
  if (recipients.length === 0 || !contentHash) return null
  const others = audience(members, ownerKey)
  const holders = currentHolders(recipients, contentHash, new Map(others.map((m) => [m.publicKey, m])))
  if (holders.length === 0) return null
  return {
    holders: holders.map((h) => h.member),
    count: holders.length,
    total: others.length,
    everyone: holders.length >= others.length,
  }
}

/**
 * The expanded list's two settled groups. Members in `active` (downloading or waiting right now) are
 * listed by the live group and left out of both.
 * @param {{ recipients: FileRecipient[], contentHash: string, members: SpaceMember[], ownerKey: string, active: Set<string> }} input
 * @returns {{ haveIt: HolderRow[], notYet: MissingRow[] }}
 */
export function recipientGroups({ recipients, contentHash, members, ownerKey, active }) {
  const others = audience(members, ownerKey).filter((m) => !active.has(m.publicKey))
  const haveIt = currentHolders(recipients, contentHash, new Map(others.map((m) => [m.publicKey, m])))
  const holding = new Set(haveIt.map((h) => h.member.publicKey))
  const earlier = new Set(recipients.filter((r) => r.contentHash !== contentHash).map((r) => r.personKey))
  const notYet = others
    .filter((m) => !holding.has(m.publicKey))
    .map((member) => ({ member, earlier: earlier.has(member.publicKey) }))
    .sort((a, b) => Number(b.member.online === true) - Number(a.member.online === true)
      || (a.member.displayName || '').localeCompare(b.member.displayName || ''))
  return { haveIt, notYet }
}

/**
 * One folder file's recipients with the folder's mirrors folded in. A member who mirrors the folder
 * is counted by the mirror alone, as holding the version shared now at the mirror's last update —
 * in every sync state: the record is one state for the whole folder, so a syncing or paused mirror
 * still holds what it already fetched, and a file it is fetching now shows as a live download. The
 * files they downloaded one by one count again once they stop mirroring. With no mirror the input
 * is returned as is.
 * @param {FileRecipient[]} recipients @param {MirrorParticipant[]} mirrors
 * @param {string} path @param {string} contentHash
 * @returns {FileRecipient[]}
 */
export function withMirrors(recipients, mirrors, path, contentHash) {
  if (mirrors.length === 0) return recipients
  const mirroring = new Set(mirrors.map((m) => m.mirrorer))
  const rows = recipients.filter((r) => !mirroring.has(r.personKey))
  for (const m of mirrors) {
    rows.push({ shareId: m.shareId, path, personKey: m.mirrorer, contentHash, ts: m.updatedAt ?? m.mountedAt })
  }
  return rows
}

// A loose row is '/'-rooted and unique in the space; a folder row is its share-relative path, so
// it is looked up with its share.
/** @param {string} path @param {string} [shareId] */
export const recipientKey = (path, shareId) => (shareId === undefined ? path : `${shareId}\0${path}`)

/** @param {FileRecipient[]} a @param {FileRecipient[]} b */
const sameRows = (a, b) =>
  a.length === b.length && a.every((r, i) => r.personKey === b[i].personKey && r.contentHash === b[i].contentHash && r.ts === b[i].ts)

/**
 * The rows by file, keyed with recipientKey. A file whose rows are unchanged from `prev` keeps its
 * array, and with no change at all `prev` itself is returned, so one new copy re-renders one row.
 * @param {FileRecipient[]} rows @param {Map<string, FileRecipient[]>} prev
 * @returns {Map<string, FileRecipient[]>}
 */
export function indexRecipients(rows, prev) {
  /** @type {Map<string, FileRecipient[]>} */
  const next = new Map()
  for (const row of rows) {
    const key = row.path.startsWith('/') ? recipientKey(row.path) : recipientKey(row.path, row.shareId)
    const list = next.get(key)
    if (list) list.push(row)
    else next.set(key, [row])
  }
  let changed = prev.size !== next.size
  for (const [key, list] of next) {
    const old = prev.get(key)
    if (old && sameRows(old, list)) next.set(key, old)
    else changed = true
  }
  return changed ? next : prev
}
