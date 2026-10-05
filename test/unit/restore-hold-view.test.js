import test from 'brittle'
import { restoreHoldView, restoreBannerCopy } from '../../src/renderer/model/restore-hold-view.js'

const PROFILE = { verdict: 'no-holder', length: 0, target: 0, released: false }

test('nothing restored: everything is writable', (t) => {
  const view = restoreHoldView(null)
  t.absent(view.active)
  t.ok(view.canWriteProfile)
  t.ok(view.canShareIn('s1'))
})

test('a held profile holds every profile write and sharing everywhere', (t) => {
  const view = restoreHoldView({ source: 'backup', profile: PROFILE, heldSpaceIds: ['s1'] })
  t.ok(view.active)
  t.absent(view.canWriteProfile)
  t.absent(view.canShareIn('s2'), 'sharing publishes into the profile too')
})

test('a released profile keeps holding until the worker restarts', (t) => {
  const view = restoreHoldView({ source: 'key', profile: { ...PROFILE, verdict: 'caught-up', released: true }, heldSpaceIds: [] })
  t.absent(view.canWriteProfile, 'the worker still refuses until its restart')
})

test('after the profile, a held catalog holds sharing in its space only', (t) => {
  const view = restoreHoldView({ source: 'backup', profile: null, heldSpaceIds: ['s1'] })
  t.absent(view.active, 'no banner')
  t.ok(view.canWriteProfile)
  t.absent(view.canShareIn('s1'))
  t.ok(view.canShareIn('s2'))
})

test('the banner names the restore by its source, and says when nobody is there to ask', (t) => {
  const backup = restoreBannerCopy(restoreHoldView({ source: 'backup', profile: PROFILE, heldSpaceIds: [] }))
  t.alike(backup, { lead: 'restore.bannerBackupLead', detail: 'restore.bannerBackupDetail', waiting: true })
  const key = restoreBannerCopy(restoreHoldView({ source: 'key', profile: { ...PROFILE, verdict: 'downloading' }, heldSpaceIds: [] }))
  t.alike(key, { lead: 'restore.bannerKeyLead', detail: 'restore.bannerKeyDetail', waiting: false })
})
