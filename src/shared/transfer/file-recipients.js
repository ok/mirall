// Who holds a verified copy of a file we share: one row per (file, member) in the local spaces bee,
// holding the latest version that member reported. Owner-only and never replicated — no other member
// can observe a transfer between two peers. A member is noted when they confirm a verified download
// (share-received) or, for a peer that never confirms, when our own serve covered the whole file.
// A first-time row is recorded as serve.completed, which is also what raises the notification.
import { spacesMeta, getSpace } from '../spaces/space.js'
import { prefixRange } from '../core/bee-keys.js'
import { createLogger } from '../core/logger.js'
import { Subsystem } from '../core/subsystem.js'
import { record } from '../audit/audit-log.js'
import { peerActor, spaceRef, targetRef } from '../audit/audit-record.js'
import { TARGET_KIND } from '../contract/audit-kinds.js'
import { rendererPath } from './transfer-id.js'
/** @import { FileRecipient } from '../contract/responses.js' */

const log = createLogger('file-recipients')

const RECIPIENT_PREFIX = 'recipient/'
const spaceRange = (spaceId) => prefixRange(RECIPIENT_PREFIX + spaceId + '/')
// relPath is last because it may itself contain '/'; no other segment can.
const recipientKey = ({ spaceId, shareId, personKey, relPath }) =>
  RECIPIENT_PREFIX + [spaceId, shareId, personKey, relPath].join('/')

function parseKey(key, spaceId) {
  const rest = key.slice((RECIPIENT_PREFIX + spaceId + '/').length)
  const a = rest.indexOf('/')
  const b = a < 0 ? -1 : rest.indexOf('/', a + 1)
  if (b < 0) return null
  return { shareId: rest.slice(0, a), personKey: rest.slice(a + 1, b), relPath: rest.slice(b + 1) }
}

let ipc = null
// key → the write in flight for it: a get → compare → put per key, so two confirmations of one copy
// cannot both read "new" and record twice.
const writes = new Map()

function baseName(relPath) {
  const i = relPath.lastIndexOf('/')
  return i >= 0 ? relPath.slice(i + 1) : relPath
}

async function writeRecipient(key, note) {
  const prev = await spacesMeta().get(key)
  if (prev?.value?.contentHash === note.contentHash) return false
  await spacesMeta().put(key, { contentHash: note.contentHash, ts: Date.now() })
  ipc?.emit('event:recipients-updated', { spaceId: note.spaceId })
  const space = await getSpace(note.spaceId)
  const member = (space?.members || []).find((m) => m.publicKey === note.personKey)
  record('serve.completed', {
    actor: peerActor(note.personKey, member?.displayName || null),
    space: spaceRef(note.spaceId, space?.name ?? null),
    target: targetRef(TARGET_KIND.FILE, note.contentHash, baseName(note.relPath)),
    subject: { bytes: note.size ?? null, path: rendererPath(note.shareId, note.relPath) },
  }, { space: note.spaceId.slice(0, 12) })
  return true
}

/**
 * @param {{ spaceId: string, shareId: string, relPath: string, contentHash: string, personKey: string, size?: number | null }} note
 * @returns {Promise<boolean>} whether this was a version the member did not hold yet
 */
export function noteFileRecipient(note) {
  if (!ipc) return Promise.resolve(false)
  const key = recipientKey(note)
  const prev = writes.get(key) ?? Promise.resolve(false)
  const next = prev.then(() => writeRecipient(key, note)).catch((err) => {
    log.warn('file recipient not saved:', note.relPath, '-', err.message)
    return false
  })
  writes.set(key, next)
  next.finally(() => { if (writes.get(key) === next) writes.delete(key) })
  return next
}

/** @param {string} spaceId @returns {Promise<FileRecipient[]>} */
export async function listFileRecipients(spaceId) {
  const rows = []
  for await (const entry of spacesMeta().createReadStream(spaceRange(spaceId))) {
    const parts = parseKey(entry.key, spaceId)
    if (!parts || typeof entry.value?.contentHash !== 'string') continue
    rows.push({
      shareId: parts.shareId,
      path: rendererPath(parts.shareId, parts.relPath),
      personKey: parts.personKey,
      contentHash: entry.value.contentHash,
      ts: Number(entry.value.ts) || 0,
    })
  }
  return rows
}

/** @param {string} spaceId */
export async function clearFileRecipients(spaceId) {
  const keys = []
  for await (const entry of spacesMeta().createReadStream(spaceRange(spaceId))) keys.push(entry.key)
  for (const key of keys) await spacesMeta().del(key)
}

export class FileRecipients extends Subsystem {
  constructor(name, deps) { super(name, deps); this.require('ipc') }

  async _open() {
    ipc = this.deps.ipc
  }

  // Started before the serve ledger, so the sessions its close reaps still land here.
  async _close() {
    await Promise.allSettled([...writes.values()])
    writes.clear()
    ipc = null
  }
}
