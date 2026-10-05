// What the backup remembers on this device between runs: when it was set up and last succeeded, the
// recovery key it keeps in the folder (sealed under the passphrase, as in the folder itself), and where
// its prompts stand. Kept beside the store rather than in config.json —
// none of it is a preference — and written whole and atomically. A file that cannot be read is a fresh
// start: at worst a prompt shows again.
import fs from 'bare-fs'
import path from 'bare-path'
import b4a from 'b4a'
import { writeFileAtomic } from '../../core/atomic-file.js'
import { readRecoveryHeader } from '../../contract/recovery-key.js'
import { freshState } from './prompt-rules.js'

export const BACKUP_STATE_FILE = 'backup-state.json'
const VERSION = 1

const stateFile = (storagePath) => path.join(path.dirname(storagePath), BACKUP_STATE_FILE)
const isTime = (value) => value === null || (typeof value === 'number' && Number.isFinite(value))
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

function parse(parsed) {
  const base = freshState()
  if (!isObject(parsed) || parsed.v !== VERSION) return base
  const out = { ...base }
  for (const key of ['setupAt', 'lastSuccessAt', 'keyCheckedAt', 'secondCopyAt']) if (isTime(parsed[key])) out[key] = parsed[key]
  const header = typeof parsed.keyContent === 'string' ? readRecoveryHeader(parsed.keyContent) : null
  if (header) {
    out.keyContent = parsed.keyContent
    out.keyCreatedAt = header.createdAt
    out.keyInFolder = parsed.keyInFolder === true
  }
  if (isObject(parsed.offer) && Number.isInteger(parsed.offer.dismissals) && isTime(parsed.offer.nextAt) && parsed.offer.nextAt !== null) {
    out.offer = { dismissals: parsed.offer.dismissals, nextAt: parsed.offer.nextAt }
  }
  if (isObject(parsed.check) && isTime(parsed.check.nextAt)) {
    out.check = { nextAt: parsed.check.nextAt, snoozed: parsed.check.snoozed === true, optOut: parsed.check.optOut === true }
  }
  return out
}

export function loadBackupState(storagePath) {
  try {
    return parse(JSON.parse(fs.readFileSync(stateFile(storagePath), 'utf-8')))
  } catch {
    return freshState()
  }
}

export async function saveBackupState(storagePath, state) {
  await writeFileAtomic(stateFile(storagePath), b4a.from(JSON.stringify({ v: VERSION, ...state })))
}
