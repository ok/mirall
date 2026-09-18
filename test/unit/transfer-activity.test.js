import test from 'brittle'
import { transfersMoving, TRANSFER_QUIET_MS } from '../../src/shared/transfer/transfer-activity.js'

const NOW = 1_000_000
const quiet = () => false
const moving = () => true
const rows = (list) => async () => list

test('a serve inside the window is movement on its own', async (t) => {
  t.is(await transfersMoving({ now: NOW, serves: moving, list: rows([]) }), true)
})

test('a pending row touched inside the window is movement', async (t) => {
  const row = [{ updatedAt: NOW - 1000 }]
  t.is(await transfersMoving({ now: NOW, serves: quiet, list: rows(row) }), true)
})

// Parked, not moving: a paused download, an owner that went offline, a row that errored. These are
// what a reconnect would UNPARK, so waiting for them would be waiting for the wrong thing.
test('a pending row that has not moved for longer than the window is parked', async (t) => {
  const row = [{ updatedAt: NOW - TRANSFER_QUIET_MS - 1 }]
  t.is(await transfersMoving({ now: NOW, serves: quiet, list: rows(row) }), false)
})

test('a pending row that errored is parked whatever its timestamp says', async (t) => {
  const row = [{ updatedAt: NOW, errorCode: 'owner-offline' }]
  t.is(await transfersMoving({ now: NOW, serves: quiet, list: rows(row) }), false)
})

test('a row with no timestamp at all is parked', async (t) => {
  t.is(await transfersMoving({ now: NOW, serves: quiet, list: rows([{}]) }), false)
})

test('nothing anywhere is not movement', async (t) => {
  t.is(await transfersMoving({ now: NOW, serves: quiet, list: rows([]) }), false)
})

// The answer gates a setting the user asked for; an unreadable store must not hold it hostage.
test('a pending store that cannot be read reads as nothing moving', async (t) => {
  const broken = async () => { throw new Error('bee closed') }
  t.is(await transfersMoving({ now: NOW, serves: quiet, list: broken }), false)
})
