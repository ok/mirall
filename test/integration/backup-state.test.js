import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { tmpDir } from '../helpers/bare-tmp.js'
import { loadBackupState, saveBackupState, BACKUP_STATE_FILE } from '../../src/shared/storage/backup/backup-state.js'

const SETUP = 1_790_000_000_000
const DAY = 24 * 60 * 60 * 1000

// A data folder holding the given backup-state.json, as the release that wrote it left it.
function stored(t, record) {
  const dir = tmpDir('backup-state', t)
  fs.writeFileSync(path.join(dir, BACKUP_STATE_FILE), JSON.stringify({ v: 1, ...record }))
  return path.join(dir, 'app-storage')
}

const shared = (lastSuccessAt, managed) => ({ setupAt: SETUP, lastSuccessAt, keyCheckedAt: null, managed: { folder: '/share/me', repoId: 'r1', ...managed } })

test('REGRESSION (FIX-BACKUP-1: managed last success lost on upgrade): a success after the organization\'s setup moves to its record', async (t) => {
  const state = loadBackupState(stored(t, shared(SETUP + DAY, { setupAt: SETUP })))
  t.is(state.managed.lastSuccessAt, SETUP + DAY, 'the organization\'s folder keeps its last backup')
  t.is(state.lastSuccessAt, null, 'and it no longer counts for the person\'s own folder')
  t.is(state.managed.setupAt, SETUP)
})

test('a success from before the organization\'s setup stays the person\'s own', async (t) => {
  const state = loadBackupState(stored(t, shared(SETUP - DAY, { setupAt: SETUP })))
  t.is(state.managed.lastSuccessAt, null)
  t.is(state.lastSuccessAt, SETUP - DAY)
})

test('an organization\'s folder never set up takes no success', async (t) => {
  const state = loadBackupState(stored(t, shared(SETUP + DAY, { setupAt: null })))
  t.is(state.managed.lastSuccessAt, null)
  t.is(state.lastSuccessAt, SETUP + DAY)
})

test('a record that keeps its own last success is read as written, the carry-over never repeats', async (t) => {
  const storage = stored(t, shared(SETUP + 2 * DAY, { setupAt: SETUP, lastSuccessAt: null }))
  const state = loadBackupState(storage)
  t.is(state.managed.lastSuccessAt, null, 'an empty record stays empty')
  t.is(state.lastSuccessAt, SETUP + 2 * DAY, 'and the person\'s own success stays theirs')

  const carried = loadBackupState(stored(t, shared(SETUP + DAY, { setupAt: SETUP })))
  await saveBackupState(storage, { ...carried, lastSuccessAt: SETUP + 3 * DAY })
  const again = loadBackupState(storage)
  t.is(again.managed.lastSuccessAt, SETUP + DAY, 'a carried value is written in its own record')
  t.is(again.lastSuccessAt, SETUP + 3 * DAY, 'and a later own success is not taken by it')
})
