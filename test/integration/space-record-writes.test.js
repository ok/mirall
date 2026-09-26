import test from 'brittle'
import { freshPeer } from '../helpers/store.js'
import { updateSpace, toggleFavorite, getSpace, mutateSpace, mutateMembers, _spacesBeeForTests } from '../../src/shared/spaces/space.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'

// Every read-modify-write of a space record has to run on the one per-space chain. Two that
// do not serialize will lose-update: both read the same record, and whichever puts last wins
// with a value that never saw the other's field.

test('REGRESSION (DL-5): a favorite toggle racing an update does not drop the download folder', async (t) => {
  await freshPeer(t)
  const space = await createSpace('Aurora')

  // Started together, not awaited in turn — this is the real shape of the bug: space:update
  // awaits a folder validation (statSync + write probe + a mount scan) while the user clicks
  // the star, so the toggle's read lands inside the update's window.
  const [updated] = await Promise.all([
    updateSpace(space.spaceId, 'Aurora', space.icon, { downloadFolder: '/tmp/aurora-dl' }),
    toggleFavorite(space.spaceId),
  ])

  const durable = await getSpace(space.spaceId)
  t.is(updated.downloadFolder, '/tmp/aurora-dl', 'the update returns the folder it set')
  t.is(durable.downloadFolder, '/tmp/aurora-dl', 'and the durable record still carries it')
  t.is(durable.favorite, true, 'without losing the favorite the other write set')
})

test('REGRESSION (SPACE-UPDATE-PARTIAL): an update that omits the name and icon keeps both', async (t) => {
  await freshPeer(t)
  const space = await createSpace('Draco', 'star')

  // space:update declares name and icon optional, and the handler forwards them as sent.
  const updated = await updateSpace(space.spaceId, undefined, null, { downloadFolder: '/tmp/draco-dl' })

  const durable = await getSpace(space.spaceId)
  t.is(durable.name, 'Draco', 'the name survives')
  t.is(durable.icon, 'star', 'the icon survives')
  t.is(durable.downloadFolder, '/tmp/draco-dl', 'and the field that was sent lands')
  t.is(updated.name, 'Draco', 'the answer carries the kept name')
})

test('the reverse order loses neither write either', async (t) => {
  await freshPeer(t)
  const space = await createSpace('Borealis')

  const [, updated] = await Promise.all([
    toggleFavorite(space.spaceId),
    updateSpace(space.spaceId, 'Renamed', space.icon, { downloadFolder: '/tmp/borealis-dl' }),
  ])

  const durable = await getSpace(space.spaceId)
  t.is(durable.name, 'Renamed')
  t.is(durable.favorite, true)
  t.is(durable.downloadFolder, '/tmp/borealis-dl')
  t.is(updated.name, 'Renamed')
})

test('clearing the override survives a concurrent toggle', async (t) => {
  await freshPeer(t)
  const space = await createSpace('Cygnus')
  await updateSpace(space.spaceId, 'Cygnus', space.icon, { downloadFolder: '/tmp/cygnus-dl' })

  await Promise.all([
    updateSpace(space.spaceId, 'Cygnus', space.icon, { downloadFolder: null }),
    toggleFavorite(space.spaceId),
  ])

  const durable = await getSpace(space.spaceId)
  t.absent(durable.downloadFolder, 'the cleared override stays cleared')
  t.is(durable.favorite, true)
})

test('REGRESSION (#498): a mutation that changes nothing appends no block', async (t) => {
  await freshPeer(t)
  const { spaceId } = await createSpace('Quiet', 'star')
  const bee = _spacesBeeForTests()
  const length = bee.core.length

  t.ok(await mutateSpace(spaceId, (s) => ({ ...s })), 'an equal record still resolves to the record')
  t.is(await mutateMembers(spaceId, (ms) => ms.map((m) => ({ ...m }))), false, 'an equal member list reports no write')
  const updated = await updateSpace(spaceId, 'Quiet', 'star')
  t.is(updated?.name, 'Quiet', 'an edit to the same values still answers with the record')
  t.is(bee.core.length, length, 'none of the three appended a block')

  await updateSpace(spaceId, 'Loud', 'star')
  t.is(bee.core.length, length + 1, 'a real change still writes')
})
