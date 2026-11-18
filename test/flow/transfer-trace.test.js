import test from 'brittle'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpaceWithApproval, waitForCatalogEntry } from '../helpers/peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'
import { waitFor } from '../helpers/poll.js'
import { tmpPath } from '../helpers/tmp.js'

const SIZE = 1024 * 1024
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const traced = (extra = {}) => ({ identityKEK: crypto.randomBytes(32).toString('hex'), transferTrace: true, testRunName: 'flow', ...extra })
const traceOf = (storage) => fs.readFileSync(path.join(path.dirname(storage), 'transfer-trace', 'trace.ndjson'), 'utf-8')
  .trim().split('\n').map((line) => JSON.parse(line))
const eventsOf = (lines) => lines.filter((line) => line.k === 'event').map((line) => line.e)

// The download is capped so it spans several one-second samples; the trace of each side is then
// read back and the two are held against each other.
test('a traced transfer leaves a trace on both sides, and the two agree', { timeout: scaled(180000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const aStorage = idStore(t)
  const bStorage = idStore(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: aStorage, downloads: mkTmpDir(t), flags: traced() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: bStorage, downloads: mkTmpDir(t), flags: traced({ downloadKBps: 256 }) })
  const spaceId = await connectInSpaceWithApproval(t, A, B)

  const src = tmpPath('mirall-trace-src') + '.bin'
  fs.writeFileSync(src, crypto.randomBytes(SIZE))
  t.teardown(() => { try { fs.rmSync(src) } catch {} })
  await A.request('files:add', { spaceId, filePath: src, fileName: 'secret-report.bin', fileSize: SIZE })
  const entry = await waitForCatalogEntry(B, spaceId, '/secret-report.bin')
  const done = B.waitFor('event:transfer-complete', (m) => m.path === '/secret-report.bin')
  await B.request('files:download', { spaceId, path: entry.path, ownerKey: entry.owner.publicKey })
  await done

  const fetching = traceOf(bStorage)
  const serving = traceOf(aStorage)

  for (const [side, lines] of [['fetching', fetching], ['serving', serving]]) {
    t.alike({ k: lines[0].k, v: lines[0].v, run: lines[0].run }, { k: 'header', v: 2, run: 'flow' }, side + ': starts with the header')
    t.ok(eventsOf(lines).includes('conn-open'), side + ': the connection opening is recorded')
    const conn = lines.find((line) => line.k === 'conn')
    t.ok(conn && conn.cwnd > 0 && conn.mtu > 0 && Number.isFinite(conn.rtt), side + ': the transport reports its window, packet size and round trip')
    t.ok(conn.recvBuffer > 0, side + ': and its socket the buffer')
    const host = lines.find((line) => line.k === 'host')
    t.ok(host && Number.isFinite(host.lagMs) && Number.isFinite(host.threadPct), side + ': the host is sampled')
    const text = JSON.stringify(lines)
    t.absent(text.includes('secret-report') || text.includes(entry.owner.publicKey), side + ': no file name and no peer key')
  }

  const fetchEvents = eventsOf(fetching)
  t.ok(fetchEvents.indexOf('fetch-start') !== -1 && fetchEvents.indexOf('fetch-end') > fetchEvents.indexOf('fetch-start'), 'the fetch has its start and its end')
  t.is(fetching.find((line) => line.e === 'fetch-end').ok, true)
  const fetchSamples = fetching.filter((line) => line.k === 'fetch')
  t.ok(fetchSamples.length >= 2, 'the fetch was sampled across several seconds')
  const sample = fetchSamples.find((line) => line.holders?.length === 1)
  t.ok(sample, 'a sample names its one holder')
  t.is(sample.totalBytes, SIZE)
  t.ok(fetching.some((line) => line.k === 'conn' && line.c === sample.holders[0][0]), 'and that holder is a connection the trace sampled')
  t.ok(fetchSamples.some((line) => line.pacing === true), 'the download cap shows as pacing')

  t.ok(eventsOf(serving).includes('serve-start'), 'the holder recorded the serve starting')
  const serveSamples = serving.filter((line) => line.k === 'serve')
  t.ok(serveSamples.length >= 2, 'the serve was sampled across several seconds')
  t.ok(serveSamples.at(-1).bytes <= SIZE && serveSamples.at(-1).bytes > 0)
  t.ok(serving.some((line) => line.k === 'conn' && line.c === serveSamples[0].c), 'on a connection the trace sampled')

  const span = (lines, kind) => { const at = lines.filter((line) => line.k === kind).map((line) => line.t); return [Math.min(...at), Math.max(...at)] }
  const [fetchFrom, fetchTo] = span(fetching, 'fetch')
  const [serveFrom, serveTo] = span(serving, 'serve')
  t.ok(fetchFrom <= serveTo && serveFrom <= fetchTo, 'the two sides sampled the same stretch of time')
})

// The path check comes from the test run file. Bob's file asks for one; Alice's only allows it.
// The check runs over the content connection with no file involved, and both traces record it.
test('a path check runs between two peers whose test run files allow it', { timeout: scaled(180000) }, async (t) => {
  const CHECK_BYTES = 32 * 1024 * 1024
  const bootstrap = await localTestnet(t)
  const aStorage = idStore(t)
  const bStorage = idStore(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: aStorage, downloads: mkTmpDir(t), flags: traced({ transferLevers: { pathCheck: true } }) })
  const B = await launchPeer(t, {
    bootstrap, displayName: 'Bob', storage: bStorage, downloads: mkTmpDir(t),
    flags: traced({ transferLevers: { pathCheck: true, pathCheckBytes: CHECK_BYTES } }),
  })
  await connectInSpaceWithApproval(t, A, B)

  const ended = (storage) => traceOf(storage).find((line) => line.e === 'check-end')
  await waitFor(() => ended(aStorage) && ended(bStorage), 60000, { interval: 250, label: 'the path check to end on both sides' })
  for (const [side, storage] of [['asking', bStorage], ['sending', aStorage]]) {
    const events = traceOf(storage).filter((line) => line.k === 'event')
    const startAt = events.findIndex((line) => line.e === 'check-start')
    const endAt = events.findIndex((line) => line.e === 'check-end')
    t.ok(startAt !== -1 && endAt > startAt, side + ': the check has its start and its end')
    t.is(events[endAt].ok, true, side + ': and it ran to the last byte')
    t.is(events[endAt].c, events[startAt].c, side + ': on one connection')
  }
  const counted = [...traceOf(bStorage), ...traceOf(aStorage)].filter((line) => line.k === 'check')
  t.ok(counted.every((line) => line.totalBytes === CHECK_BYTES && (line.rxBytes ?? line.txBytes) <= CHECK_BYTES), 'a sampled second of it stays within the amount asked for')

  t.is(traceOf(bStorage).filter((line) => line.e === 'check-start').length, 1, 'the check was asked for once')
})
