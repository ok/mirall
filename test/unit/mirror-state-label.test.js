import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { mirrorStateLabelKey } from '../../src/renderer/mirrorStateLabel.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const en = JSON.parse(fs.readFileSync(path.resolve(here, '../../src/renderer/locales/en/common.json'), 'utf8'))
const lookup = (key) => key.split('.').reduce((node, part) => node?.[part], en)

test('REGRESSION (FIX-M4-2): a syncing mirrorer reads as waiting while the owner is away', (t) => {
  t.is(mirrorStateLabelKey('syncing', false), 'folder.mirrorStateWaiting')
})

test('a syncing mirrorer with the owner present still reads as syncing', (t) => {
  t.is(mirrorStateLabelKey('syncing', true), 'folder.mirrorStateSyncing')
})

test('synced does not depend on the owner — holding every file is not a claim about them', (t) => {
  t.is(mirrorStateLabelKey('synced', false), 'folder.mirrorStateSynced')
})

test('paused is the user\'s own intent and outranks the outage', (t) => {
  t.is(mirrorStateLabelKey('paused', false), 'folder.mirrorStatePaused')
})

test('an omitted ownerOnline is treated as reachable', (t) => {
  // An unloaded roster must not flash "waiting" on every folder open.
  t.is(mirrorStateLabelKey('syncing', undefined), 'folder.mirrorStateSyncing')
})

test('every key it returns exists in en/common.json', (t) => {
  for (const s of ['syncing', 'synced', 'paused']) {
    for (const on of [true, false]) {
      const key = mirrorStateLabelKey(s, on)
      t.ok(typeof lookup(key) === 'string' && lookup(key).length > 0, `${key} resolves`)
    }
  }
})
