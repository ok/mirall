import test from 'brittle'
import { freshPeer } from '../helpers/store.js'
import { getProfile, setProfile, getLocalPublicKeyHex } from '../../src/shared/spaces/profile.js'

test('getProfile returns the persisted identity shape', async (t) => {
  await freshPeer(t, { displayName: 'Ada' })
  const p = await getProfile()
  t.is(p.displayName, 'Ada')
  t.is(p.avatar, null, 'no avatar set yet')
  t.is(p.personKey, getLocalPublicKeyHex(), 'the person key is the stable bee key')
  t.is(p.deviceKey, p.personKey, 'one install is one person and one device')
  t.is(p.orgKey, null, 'no org asserts this install')
  t.ok(/^[0-9a-f]{64}$/.test(p.personKey), 'the person key is 32-byte hex')
})

test('setProfile updates name + avatar; omitting avatar leaves it intact; key is stable', async (t) => {
  await freshPeer(t, { displayName: 'Ada' })
  const key0 = (await getProfile()).personKey

  await setProfile({ displayName: 'Grace', avatar: 'data:image/png;base64,AAAA' })
  let p = await getProfile()
  t.is(p.displayName, 'Grace')
  t.is(p.avatar, 'data:image/png;base64,AAAA')

  await setProfile({ displayName: 'Grace H.' })
  p = await getProfile()
  t.is(p.avatar, 'data:image/png;base64,AAAA', 'avatar preserved when not provided')
  t.is(p.personKey, key0, 'identity key stable across edits')
})
