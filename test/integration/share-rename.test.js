import test from 'brittle'
import { freshPeer } from '../helpers/store.js'
import { createSpace } from '../../src/shared/spaces/space.js'
import { publishShare, readOwnShares, generateShareId, isValidShareName } from '../../src/shared/shares/shares.js'
import { getLocalPublicKeyHex } from '../../src/shared/spaces/profile.js'

async function setup (t, names = ['Movies']) {
  await freshPeer(t)
  const space = await createSpace('Aurora')
  const ids = []
  for (const name of names) {
    const id = generateShareId()
    ids.push(id)
    await publishShare(space.spaceId, {
      id, type: 'owned-folder', name, owner: getLocalPublicKeyHex(),
      contentMode: 'overlay', catalogKey: 'c'.repeat(64), createdAt: Date.now(),
    })
  }
  return { spaceId: space.spaceId, ids }
}

// share:rename writes `displayName` and never touches `name`, because `name` is the first segment
// of the consumer drive path ('/<name>/<relPath>') that keys every download claim and pending
// transfer on every member's machine. These assert the record shape that promise rests on.
const labelOf = (s) => s.displayName || s.name

test('a rename adds a label and leaves the keyed name alone', async (t) => {
  const { spaceId, ids } = await setup(t)
  const before = (await readOwnShares(spaceId)).find((s) => s.id === ids[0])
  await publishShare(spaceId, { ...before, displayName: 'Olli’s Movies' })

  const own = await readOwnShares(spaceId)
  t.is(own.length, 1, 'a rename does not create a second share')
  t.is(own[0].id, before.id, 'same id')
  t.is(own[0].name, 'Movies', 'the drive-path segment is untouched — claims keep resolving')
  t.is(own[0].displayName, 'Olli’s Movies', 'and the label is what changed')
  t.is(own[0].catalogKey, before.catalogKey, 'same catalog — no re-index, no mirror churn')
  t.is(own[0].createdAt, before.createdAt, 'same creation time')
})

test('renaming back to the on-disk name drops the override', async (t) => {
  const { spaceId, ids } = await setup(t)
  const before = (await readOwnShares(spaceId)).find((s) => s.id === ids[0])
  const renamed = { ...before, displayName: 'Olli’s Movies' }
  await publishShare(spaceId, renamed)
  const back = { ...renamed }
  delete back.displayName
  await publishShare(spaceId, back)

  const after = (await readOwnShares(spaceId)).find((s) => s.id === ids[0])
  t.absent(after.displayName, 'no duplicate of the real name is stored')
  t.is(labelOf(after), 'Movies', 'and the label falls back to it')
})

test('the collision rule compares LABELS, which is what a user sees', async (t) => {
  const { spaceId, ids } = await setup(t, ['Movies', 'Music'])
  const own = await readOwnShares(spaceId)
  const target = own.find((s) => s.id === ids[0])

  t.ok(own.some((s) => s.id !== target.id && labelOf(s) === 'Music'), 'a sibling already owns that label')
  t.absent(own.some((s) => s.id !== target.id && labelOf(s) === 'Photos'), 'an unused label is free')

  // A sibling renamed to X makes X taken even though no share is NAMED X on disk.
  const sibling = own.find((s) => s.id === ids[1])
  await publishShare(spaceId, { ...sibling, displayName: 'Photos' })
  const after = await readOwnShares(spaceId)
  t.ok(after.some((s) => s.id !== target.id && labelOf(s) === 'Photos'), 'the label is taken by the override')
  t.absent(after.some((s) => s.id !== target.id && labelOf(s) === 'Music'), 'and its old label is free again')
})

test('the name guard rejects what the create path rejects', (t) => {
  t.ok(isValidShareName('Olli’s Movies'))
  t.absent(isValidShareName(''), 'empty')
  t.absent(isValidShareName('   '), 'whitespace only')
  t.absent(isValidShareName('a'.repeat(500)), 'absurdly long')
})
