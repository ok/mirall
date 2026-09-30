// Resume journals live in app-private storage beside the Corestore, never next to a download. This
// module is the one app door to them: the engine owns their name and format, this file owns where
// they live, and every caller asks by final path. The directory is resolved per call and a store
// that is not open yet reads as "no journals", since the boot sweep and a discard can run while the
// overlay is down.
import path from 'bare-path'
import { getStoragePath } from '../../core/store.js'
import { hasJournal, discardJournal, cleanupOrphanedJournals } from './engine/transfer/journal.js'

export function getJournalDir() {
  return path.join(path.dirname(getStoragePath()), 'journals')
}

function journalDirOrNull() {
  try { return getJournalDir() } catch { return null }
}

export function hasResumeJournal(finalPath) {
  const dir = journalDirOrNull()
  return dir ? hasJournal(dir, finalPath) : false
}

export function discardResumeJournal(finalPath) {
  const dir = journalDirOrNull()
  if (dir) discardJournal(dir, finalPath)
}

// The journals removed.
export function sweepOrphanedJournals() {
  const dir = journalDirOrNull()
  return dir ? cleanupOrphanedJournals(dir) : []
}
