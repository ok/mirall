import test from 'brittle'
import { freshPeer } from '../helpers/store.js'
import { getProfile, setProfile, getLocalPublicKeyHex } from '../../src/shared/spaces/profile.js'

test('getProfile returns the persisted identity shape', async (t) => {
  await freshPeer(t, { displayName: 'Ada' })
  const p = await getProfile()
  t.is(p.displayName, 'Ada')
  t.is(p.avatar, null, 'no avatar set yet')
  t.is(p.publicKey, getLocalPublicKeyHex(), 'publicKey is the stable bee key')
  t.ok(/^[0-9a-f]{64}$/.test(p.publicKey), 'publicKey is 32-byte hex')
})

test('setProfile updates name + avatar; omitting avatar leaves it intact; key is stable', async (t) => {
  await freshPeer(t, { displayName: 'Ada' })
  const key0 = (await getProfile()).publicKey

  await setProfile({ displayName: 'Grace', avatar: 'data:image/png;base64,AAAA' })
  let p = await getProfile()
  t.is(p.displayName, 'Grace')
  t.is(p.avatar, 'data:image/png;base64,AAAA')

  await setProfile({ displayName: 'Grace H.' })
  p = await getProfile()
  t.is(p.avatar, 'data:image/png;base64,AAAA', 'avatar preserved when not provided')
  t.is(p.publicKey, key0, 'identity key stable across edits')
})
