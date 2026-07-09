import test from 'brittle'
import { fileRowAction } from '../../src/renderer/fileRowAction.js'

const manual = (status, hasTransferId = false) => fileRowAction({ status, manualControls: true, hasTransferId })
const mirror = (status, hasTransferId = false) => fileRowAction({ status, manualControls: false, hasTransferId })

test('REGRESSION (FIX-MIRROR-CONTROLS): a mirrored remote file exposes NO download action', (t) => {
  t.is(mirror('remote'), 'none', 'no Download button on a mirrored not-yet-synced file')
})

test('REGRESSION (FIX-MIRROR-CONTROLS): a mirrored in-flight file exposes NO pause/cancel', (t) => {
  t.is(mirror('downloading', true), 'busy', 'a syncing mirror row is passive, not pause/cancel')
})

test('REGRESSION (FIX-MIRROR-CONTROLS): a mirrored interrupted/unavailable file exposes NO controls', (t) => {
  t.is(mirror('paused-interrupted'), 'none')
  t.is(mirror('paused-offline'), 'none')
  t.is(mirror('unavailable'), 'none')
})

test('mirrored on-disk files keep Reveal', (t) => {
  t.is(mirror('synced'), 'reveal')
  t.is(mirror('downloaded'), 'reveal')
})

test('owner preparing indicator (#193) is preserved as a passive busy state', (t) => {
  t.is(mirror('preparing'), 'busy')
})

test('verifying behaves like downloading — pause/cancel when controllable, busy otherwise', (t) => {
  t.is(manual('verifying', true), 'pause-cancel', 'a verifying row stays pausable mid-verify')
  t.is(manual('verifying', false), 'busy')
  t.is(mirror('verifying'), 'busy', 'a mirror verify row is passive')
})

test('browse folders keep the full manual control set (unchanged behavior)', (t) => {
  t.is(manual('remote'), 'download')
  t.is(manual('downloading', true), 'pause-cancel')
  t.is(manual('downloading', false), 'busy')
  t.is(manual('paused-interrupted'), 'resume-discard')
  t.is(manual('paused-offline'), 'discard')
  t.is(manual('unavailable'), 'download-disabled')
  t.is(manual('synced'), 'reveal')
  t.is(manual('downloaded'), 'reveal')
  t.is(manual('preparing'), 'busy')
})
