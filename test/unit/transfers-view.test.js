import test from 'brittle'
import { transferCounts, filterTransfers, orderTransferSpaces, spaceTransferSummary, transferBulkVerb, needsAttention } from '../../src/renderer/model/transfers-view.js'

const dl = (status) => ({ kind: 'loose', shareId: '__loose__', ownerKey: 'o', folder: null, file: { path: '/' + status, status } })
const serve = (path) => ({ spaceId: 's', path, peers: ['p'], bytes: 0, total: 0, pausedKeys: [], waitingKeys: [], shareId: '__loose__', size: 1 })
const space = (spaceId, statuses, serving = []) => ({ spaceId, downloads: statuses.map(dl), serving: serving.map(serve) })

const SPACES = [
  space('dailies', ['downloading', 'downloading', 'waiting'], ['/luts.zip']),
  space('rebrand', ['paused-interrupted'], ['/guide.pdf']),
  space('finance', ['error']),
  space('idle', ['paused-offline']),
]

test('counts follow the three kinds a transfer can be', (t) => {
  t.alike(transferCounts(SPACES), { all: 8, downloading: 3, sending: 2, attention: 3 })
  t.alike(transferCounts([]), { all: 0, downloading: 0, sending: 0, attention: 0 })
})

test('paused, owner-offline and failed downloads need attention; moving ones do not', (t) => {
  for (const s of ['paused-interrupted', 'paused-offline', 'error']) t.ok(needsAttention(s), s)
  for (const s of ['downloading', 'waiting', 'verifying']) t.absent(needsAttention(s), s)
})

test('a filter keeps its rows and drops the spaces it empties', (t) => {
  t.alike(filterTransfers(SPACES, 'all').map((s) => s.spaceId), ['dailies', 'rebrand', 'finance', 'idle'])
  const downloading = filterTransfers(SPACES, 'downloading')
  t.alike(downloading.map((s) => s.spaceId), ['dailies'])
  t.is(downloading[0].downloads.length, 3)
  t.is(downloading[0].serving.length, 0, 'a sent file is not a download')
  const sending = filterTransfers(SPACES, 'sending')
  t.alike(sending.map((s) => [s.spaceId, s.downloads.length, s.serving.length]), [['dailies', 0, 1], ['rebrand', 0, 1]])
  t.alike(filterTransfers(SPACES, 'attention').map((s) => s.spaceId), ['rebrand', 'finance', 'idle'])
})

test('spaces that need the user come first, then by name', (t) => {
  const names = { dailies: 'Studio Dailies', rebrand: 'Northwind', finance: 'Finance', idle: 'Archive' }
  const ordered = orderTransferSpaces(SPACES, (id) => names[id])
  t.alike(ordered.map((s) => s.spaceId), ['idle', 'finance', 'rebrand', 'dailies'])
})

test('a space line counts its transfers, and what is paused or failed apart', (t) => {
  t.alike(spaceTransferSummary(SPACES[0]), { transfers: 4, paused: 0, failed: 0 })
  t.alike(spaceTransferSummary(SPACES[1]), { transfers: 2, paused: 1, failed: 0 })
  t.alike(spaceTransferSummary(SPACES[2]), { transfers: 1, paused: 0, failed: 1 })
})

test('Pause All while something moves, Resume All once only paused downloads are left', (t) => {
  t.is(transferBulkVerb(SPACES), 'pause')
  t.is(transferBulkVerb([SPACES[1], SPACES[2]]), 'resume')
  t.is(transferBulkVerb([SPACES[3]]), null, 'a download waiting for its owner resumes by itself')
  t.is(transferBulkVerb([space('s', [], ['/a'])]), null, 'sending is not paused from here')
  t.is(transferBulkVerb([]), null)
})
