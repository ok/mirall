import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import url from 'bare-url'
import { freshPeer } from '../helpers/store.js'
import { getRuntimeConfig, setRuntimeConfig, getResourceCaps } from '../../src/shared/core/runtime-config.js'
import { sanitizeAvatar } from '../../src/shared/identity-limits.js'
import {
  getLocalPublicKeyHex, getProfileBee, setProfile, getProfile,
  readProfileRecord, markRequest, readPeerRequests,
} from '../../src/shared/spaces/profile.js'

// Shrink a cap for one test, then restore the full config (storage/identity included) so later
// tests in the file are unaffected, mirroring membership-fold-bounds.test.js.
function withConfig(t, patch) {
  const prev = { ...getRuntimeConfig() }
  setRuntimeConfig({ ...prev, ...patch })
  t.teardown(() => setRuntimeConfig(prev))
}
const dataUri = (n, mime = 'image/png') => `data:${mime};base64,${'A'.repeat(n)}`

// Writing raw values into our own profile bee (bypassing setProfile) then reading them back via the
// same functions the fold uses on PEER bees faithfully simulates a malicious peer's bee: openProfileBee
// opens by key and doesn't care whose bee it is.

test('REGRESSION (FIX-MIR-12): fold read drops an over-cap / non-image peer avatar', async (t) => {
  await freshPeer(t)
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
  await freshPeer(t)
  const me = getLocalPublicKeyHex()
  await getProfileBee().put('displayName', 'x'.repeat(500))
  t.is((await readProfileRecord(me)).displayName.length, 80, 'displayName clamped on the bee-read path')
})

test('REGRESSION (FIX-MIR-12): join-request stream clamps name + drops over-cap avatar', async (t) => {
  await freshPeer(t)
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
  await freshPeer(t)
  withConfig(t, { maxAvatarBytes: 1024 })
  await setProfile({ displayName: 'z'.repeat(500), avatar: dataUri(4096, 'image/jpeg') })

  const p = await getProfile()
  t.is(p.displayName.length, 80, 'own displayName clamped before store')
  t.is(p.avatar, null, 'own over-cap avatar stored as null')
})

// REGRESSION (FIX-AVFRAME-3: the live membership:request frame was the one avatar ingress that
// did NOT sanitize — the display name beside it was clamped, the avatar was taken raw. It is
// written durably into the replicated profile bee and emitted to the renderer, so a peer-supplied
// `data:text/html` or `javascript:` value reached both. The frame budget bounds the size of what
// arrives; only sanitizeAvatar checks its shape.)
test('REGRESSION (FIX-AVFRAME-3): a hostile join-request avatar is stored as null', async (t) => {
  await freshPeer(t)
  const me = getLocalPublicKeyHex()
  const S = 'space-avframe'

  // Exactly the expression the worker's join-request ingest applies to msg.avatar.
  const avatar = sanitizeAvatar('data:text/html;base64,PHN2Zz4=', getResourceCaps().avatarMaxBytes)
  t.is(avatar, null, 'a non-image data URI is not an avatar')

  await markRequest(S, 'joiner-hostile', { displayName: 'Mallory', avatar })
  const [r] = await readPeerRequests(me, S)
  t.is(r.avatar, null, 'the replicated request receipt carries no avatar')
  t.is(r.displayName, 'Mallory', 'and the rest of the receipt is intact')
})

// The half above proves the sanitizer's verdict is what the receipt stores; this proves the worker
// ingest actually routes every consumer through it. worker/main.js is the process entry — it cannot
// be imported into a test — so the wiring is asserted over its source, as the other worker-entry
// invariants in this suite are.
test('REGRESSION (FIX-AVFRAME-3): the ingest sanitizes before all three consumers', (t) => {
  const here = path.dirname(url.fileURLToPath(import.meta.url))
  const src = fs.readFileSync(path.join(here, '..', '..', 'src', 'worker', 'main.js'), 'utf8')
  const ingest = src.slice(src.indexOf('const displayName = clampDisplayName(msg.displayName)'),
    src.indexOf('auditJoinRequest(spaceId, msg.profileKey, displayName)'))

  const sanitizeAt = ingest.indexOf('const avatar = sanitizeAvatar(msg.avatar,')
  t.ok(sanitizeAt >= 0, 'the frame avatar is sanitized on arrival')
  t.ok(/getResourceCaps\(\)\.avatarMaxBytes/.test(ingest.slice(sanitizeAt, ingest.indexOf('\n', sanitizeAt))),
    'against the STORAGE cap — an arrived frame is already under the frame cap; the shape is what is missing')

  const consumers = ingest.slice(ingest.indexOf('\n', sanitizeAt))
  t.absent(/msg\.avatar/.test(consumers), 'no consumer reads the raw frame value')
  for (const consumer of ['recordJoinRequest(', 'markRequest(', "ipc.emit('event:member-join-request'"]) {
    t.ok(consumers.includes(consumer), consumer + ' is inside the sanitized region')
  }
})
