import test from 'brittle'
import { freshPeerWithIdentity } from '../helpers/store.js'
import { getRuntimeConfig, setRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import {
  getLocalPublicKeyHex, getProfileBee, setProfile, getProfile,
  readProfileRecord, markRequest, readPeerRequests,
} from '../../src/shared/spaces/profile.js'

// Shrink a cap for one test, then restore the full config (storage/identity included) so later
// tests in the file are unaffected, mirroring membership-fold-bounds.test.js.
function withConfig (t, patch) {
  const prev = { ...getRuntimeConfig() }
  setRuntimeConfig({ ...prev, ...patch })
  t.teardown(() => setRuntimeConfig(prev))
}
const dataUri = (n, mime = 'image/png') => `data:${mime};base64,${'A'.repeat(n)}`

// Writing raw values into our own profile bee (bypassing setProfile) then reading them back via the
// same functions the fold uses on PEER bees faithfully simulates a malicious peer's bee: openProfileBee
// opens by key and doesn't care whose bee it is.

test('REGRESSION (FIX-MIR-12): fold read drops an over-cap / non-image peer avatar', async (t) => {
  await freshPeerWithIdentity(t)
  withConfig(t, { maxAvatarBytes: 1024 })
  const me = getLocalPublicKeyHex()
  const bee = getProfileBee()

  await bee.put('displayName', 'Mallory')
  await bee.put('avatar', dataUri(4096, 'image/jpeg'))
  t.is((await readProfileRecord(me)).avatar, null, 'over-cap avatar dropped on read')

  await bee.put('avatar', 'data:text/html;base64,PHN2Zz4=')
  t.is((await readProfileRecord(me)).avatar, null, 'non-image avatar dropped on read')

  const ok = dataUri(64, 'image/png')
  await bee.put('avatar', ok)
  t.is((await readProfileRecord(me)).avatar, ok, 'valid avatar preserved')
})

test('REGRESSION (FIX-MIR-12): fold read clamps an over-long peer display name', async (t) => {
  await freshPeerWithIdentity(t)
  const me = getLocalPublicKeyHex()
  await getProfileBee().put('displayName', 'x'.repeat(500))
  t.is((await readProfileRecord(me)).displayName.length, 80, 'displayName clamped on the bee-read path')
})

test('REGRESSION (FIX-MIR-12): join-request stream clamps name + drops over-cap avatar', async (t) => {
  await freshPeerWithIdentity(t)
  withConfig(t, { maxAvatarBytes: 1024 })
  const me = getLocalPublicKeyHex()
  const S = 'space-req-caps'

  // markRequest seeds the cap + a real receipt; overwrite it with a hostile payload to exercise loadPeerEntries.
  await markRequest(S, 'joiner-1', { displayName: 'seed' })
  await getProfileBee().put('request/' + S + '/joiner-1',
    { displayName: 'y'.repeat(300), avatar: dataUri(4096, 'image/jpeg'), ts: 1 })

  const [r] = await readPeerRequests(me, S)
  t.is(r.displayName.length, 80, 'request displayName clamped')
  t.is(r.avatar, null, 'over-cap request avatar dropped')
})

test('REGRESSION (FIX-MIR-12): setProfile clamps/sanitizes our own write', async (t) => {
  await freshPeerWithIdentity(t)
  withConfig(t, { maxAvatarBytes: 1024 })
  await setProfile({ displayName: 'z'.repeat(500), avatar: dataUri(4096, 'image/jpeg') })

  const p = await getProfile()
  t.is(p.displayName.length, 80, 'own displayName clamped before store')
  t.is(p.avatar, null, 'own over-cap avatar stored as null')
})
