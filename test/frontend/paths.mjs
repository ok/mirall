import { mkdtempSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const REPO = path.resolve(import.meta.dirname, '../..')

// Keep all runtime dirs (stores, downloads, picked source files/folders) under
// the repo, NOT os.tmpdir() (= /private/var/...), which macOS treats as a
// protected area and blocks the native file/folder picker from navigating into.
export const WORK = path.join(REPO, 'test/frontend/.work')
mkdirSync(WORK, { recursive: true })

export function workDir(prefix) {
  return mkdtempSync(path.join(WORK, prefix))
}
