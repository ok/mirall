import test from 'brittle'
import { mergeMemberIdentity, displayNameOrNull, UNKNOWN_NAME } from '../../src/shared/spaces/member-identity.js'

const K = 'a'.repeat(64)
const DK = 'd'.repeat(64)

test('live meta wins over bee and held', (t) => {
  const { entry } = mergeMemberIdentity({
    publicKey: K,
    meta: { displayName: 'Live', avatar: 'data:live', driveKey: DK },
    profile: { displayName: 'Bee', avatar: 'data:bee' },
    held: { publicKey: K, displayName: 'Old', avatar: 'data:old', driveKey: null },
  })
  t.is(entry.displayName, 'Live')
  t.is(entry.avatar, 'data:live')
  t.is(entry.driveKey, DK)
})

test('REGRESSION (Unknown): bee fills name + avatar when no live meta', (t) => {
  const { entry, changed } = mergeMemberIdentity({
    publicKey: K, meta: null, profile: { displayName: 'Steve', avatar: 'data:steve' }, held: null,
  })
  t.is(entry.displayName, 'Steve')
  t.is(entry.avatar, 'data:steve')
  t.ok(changed)
})

test('REGRESSION (missing avatar): connected peer with null meta-avatar falls through to bee', (t) => {
  const { entry } = mergeMemberIdentity({
    publicKey: K,
    meta: { displayName: 'Steve', avatar: null, driveKey: DK },
    profile: { displayName: 'Steve', avatar: 'data:steve' },
    held: { publicKey: K, displayName: 'Steve', avatar: null, driveKey: DK },
  })
  t.is(entry.avatar, 'data:steve')
})

test('never regresses a known name to Unknown', (t) => {
  const { entry, changed } = mergeMemberIdentity({
    publicKey: K, meta: null, profile: null, held: { publicKey: K, displayName: 'Known', avatar: null, driveKey: null },
  })
  t.is(entry.displayName, 'Known')
  t.absent(changed)
})

test('brand-new member with nothing → Unknown placeholder, changed', (t) => {
  const { entry, changed } = mergeMemberIdentity({ publicKey: K, meta: null, profile: null, held: null })
  t.is(entry.displayName, 'Unknown')
  t.is(entry.avatar, null)
  t.ok(changed)
})

test('no change → changed=false (skips the write+emit)', (t) => {
  const held = { publicKey: K, displayName: 'Steve', avatar: 'data:steve', driveKey: DK }
  const { changed } = mergeMemberIdentity({
    publicKey: K, meta: { displayName: 'Steve', avatar: 'data:steve', driveKey: DK }, profile: null, held,
  })
  t.absent(changed)
})

// An audit row snapshots the name at write time and never joins at render, so the placeholder this
// module mints must not reach one — it would pin a fake, untranslated name forever, where null
// degrades to the correlatable short key instead.
test('displayNameOrNull refuses the placeholder this module mints', (t) => {
  t.is(displayNameOrNull('Steve'), 'Steve')
  t.is(displayNameOrNull(UNKNOWN_NAME), null, 'the placeholder is not a name')
  t.is(displayNameOrNull(null), null)
  t.is(displayNameOrNull(undefined), null)
  t.is(displayNameOrNull(''), null)
})

test('the placeholder it refuses is the one mergeMemberIdentity writes', (t) => {
  const { entry } = mergeMemberIdentity({ publicKey: K, meta: null, profile: null, held: null })
  t.is(entry.displayName, UNKNOWN_NAME, 'one constant, so the two cannot drift apart')
  t.is(displayNameOrNull(entry.displayName), null)
})
