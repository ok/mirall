import test from 'brittle'
import { mergeMemberIdentity, displayNameOrNull } from '../../src/shared/spaces/membership/fold.js'
import { UNKNOWN_DISPLAY_NAME } from '../../src/shared/contract/limits.js'

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
  t.is(displayNameOrNull(UNKNOWN_DISPLAY_NAME), null, 'the placeholder is not a name')
  t.is(displayNameOrNull(null), null)
  t.is(displayNameOrNull(undefined), null)
  t.is(displayNameOrNull(''), null)
})

test('the placeholder it refuses is the one mergeMemberIdentity writes', (t) => {
  const { entry } = mergeMemberIdentity({ publicKey: K, meta: null, profile: null, held: null })
  t.is(entry.displayName, UNKNOWN_DISPLAY_NAME, 'one constant, so the two cannot drift apart')
  t.is(displayNameOrNull(entry.displayName), null)
})

test('looseCatalogEpoch is carried with the same tier precedence as the key it decrypts', (t) => {
  const { entry } = mergeMemberIdentity({
    publicKey: K,
    meta: { displayName: 'Live', driveKey: DK, looseCatalogKeyEnc: DK, looseCatalogEpoch: 2 },
    profile: { looseCatalogKeyEnc: DK, looseCatalogEpoch: 1 },
    held: { publicKey: K, displayName: 'Live', driveKey: DK, looseCatalogKeyEnc: DK, looseCatalogEpoch: 0 },
  })
  t.is(entry.looseCatalogEpoch, 2, 'live meta wins')
  const fromBee = mergeMemberIdentity({ publicKey: K, meta: null, profile: { looseCatalogKeyEnc: DK, looseCatalogEpoch: 1 }, held: null })
  t.is(fromBee.entry.looseCatalogEpoch, 1, 'the profile bee fills it when there is no live meta')
})

test('the epoch always comes from the tier that supplied the encrypted key, never from another', (t) => {
  const K2 = 'e'.repeat(64)
  const { entry } = mergeMemberIdentity({
    publicKey: K,
    meta: { displayName: 'Live', driveKey: DK, looseCatalogKeyEnc: null, looseCatalogEpoch: 0 },
    profile: { looseCatalogKeyEnc: K2, looseCatalogEpoch: 2 },
    held: null,
  })
  t.is(entry.looseCatalogKeyEnc, K2, 'the key falls through to the profile')
  t.is(entry.looseCatalogEpoch, 2, 'and brings its own epoch, not the live tier\'s')
  const noKey = mergeMemberIdentity({ publicKey: K, meta: { looseCatalogEpoch: 3 }, profile: null, held: null })
  t.is(noKey.entry.looseCatalogKeyEnc, null)
  t.is(noKey.entry.looseCatalogEpoch, null, 'an epoch without a key is nothing')
})

test('a member entry that predates looseCatalogEpoch carries null and is not marked changed', (t) => {
  const held = { publicKey: K, displayName: 'Steve', avatar: null, driveKey: DK, looseCatalogKeyEnc: DK }
  const { entry, changed } = mergeMemberIdentity({ publicKey: K, meta: null, profile: null, held })
  t.is(entry.looseCatalogEpoch, null)
  t.absent(changed, 'a fold over an older record is not a change')
  const moved = mergeMemberIdentity({ publicKey: K, meta: { looseCatalogKeyEnc: DK, looseCatalogEpoch: 1 }, profile: null, held })
  t.ok(moved.changed, 'a published epoch beside the key is a change the fold reports')
})
