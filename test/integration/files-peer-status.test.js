import test from 'brittle'
import { peerFileStatus } from '../../src/shared/transfer/files.js'

// peerFileStatus maps (downloaded, pendingRow, ownerOnline) → the row status shown in the file
// list. Extracted from listFiles; this locks the precedence (downloaded wins, then error, then
// paused, then the plain remote/unavailable split) so the if-chain can't silently drift. It lives
// in integration (bare runner) because files.js imports bare-fs and won't load under node.
test('peerFileStatus resolves every (downloaded/pending/online) combination', (t) => {
  // downloaded wins outright, regardless of pending state or owner presence.
  t.is(peerFileStatus(true, null, true), 'downloaded')
  t.is(peerFileStatus(true, { errorCode: 'X' }, false), 'downloaded', 'downloaded beats a pending error')

  // not downloaded, with a pending row.
  t.is(peerFileStatus(false, { errorCode: 'X' }, true), 'error', 'a pending error wins over paused')
  t.is(peerFileStatus(false, { bytesTransferred: 10 }, true), 'paused-interrupted', 'paused + owner online')
  t.is(peerFileStatus(false, { bytesTransferred: 10 }, false), 'paused-offline', 'paused + owner offline')

  // not downloaded, no pending row.
  t.is(peerFileStatus(false, undefined, true), 'remote', 'available from an online owner')
  t.is(peerFileStatus(false, undefined, false), 'unavailable', 'owner offline, nothing local')

  // A clean pending row (no errorCode) from an offline owner is paused-offline, never
  // error — the contract the seeder-quit fix relies on (the engine records no errorCode
  // for a vanished holder, so this branch is the one reached).
  t.is(peerFileStatus(false, { bytesTransferred: 100 }, false), 'paused-offline',
    'a clean pending row from an offline owner is paused-offline, never failed')
})

// The worker owns the 'downloading' state now (single source of truth): an in-flight fetch is
// 'downloading' regardless of the durable pending row or presence, so the renderer never has to
// synthesise it (and can never latch a stale paused-offline over it).
test('REGRESSION (FIX-EDA-1: an active fetch is downloading, never paused/remote)', (t) => {
  t.is(peerFileStatus(false, { bytesTransferred: 10 }, true, true), 'downloading',
    'active + owner online → downloading, not paused-interrupted')
  t.is(peerFileStatus(false, { bytesTransferred: 10 }, false, true), 'downloading',
    'active + owner offline → downloading, not paused-offline (no stale owner-offline latch)')
  t.is(peerFileStatus(false, { errorCode: 'X' }, true, true), 'downloading',
    'active beats a stale pending errorCode')
  t.is(peerFileStatus(false, null, false, true), 'downloading',
    'active with no pending row is still downloading')
  // downloaded still wins even over an active flag (a just-completed row).
  t.is(peerFileStatus(true, null, true, true), 'downloaded')
})
