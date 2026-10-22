import test from 'brittle'
import { backupToastDecision } from '../../src/renderer/model/backup-toast.js'

const FOLDER = '/Volumes/Backup/Mirall'
const step = (previous, over = {}) => backupToastDecision({ previous, stale: false, offline: false, folder: FOLDER, ...over })

test('a backup that turns stale raises one toast, naming the folder when that is the cause', (t) => {
  t.is(step(null).action, null, 'a healthy start says nothing')
  t.alike(step(null, { stale: true }).action, { kind: 'show', cause: 'stale' })
  t.alike(step(null, { stale: true, offline: true }).action, { kind: 'show', cause: 'offline' })
  t.is(step(null, { offline: true }).action, null, 'a folder gone for less than ten days is the Backup screen\'s to say')
})

test('only a change acts, so a dismissed toast stays dismissed', (t) => {
  const shown = step(null, { stale: true, offline: true }).state
  t.is(step(shown, { stale: true, offline: true }).action, null, 'the same cause seen again on the next status')
  t.alike(step(shown, { stale: true }).action, { kind: 'show', cause: 'stale' }, 'another cause replaces it')
})

test('the same folder backed up to again is said once; any other way out just dismisses', (t) => {
  const shown = step(null, { stale: true, offline: true }).state
  t.alike(step(shown).action, { kind: 'restored' })
  t.alike(step(shown, { folder: '/Volumes/Other' }).action, { kind: 'dismiss' }, 'another folder chosen')
  t.alike(step(shown, { folder: null }).action, { kind: 'dismiss' }, 'the backup turned off')
  t.alike(step(step(null, { stale: true }).state).action, { kind: 'dismiss' }, 'a stale backup that recovers is not a folder coming back')
})
