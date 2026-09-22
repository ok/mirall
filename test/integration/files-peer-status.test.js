import test from 'brittle'
import { peerFileStatus } from '../../src/shared/transfer/file-listing.js'
import { COPY_VERDICT } from '../../src/shared/transfer/verified-copy.js'

// peerFileStatus maps (copy verdict, pendingRow, ownerOnline) → the row status shown in the file
// list. Extracted from listFiles; this locks the precedence (downloaded wins, then error, then
// paused, then the plain remote/unavailable split) so the if-chain can't silently drift. It lives
// in integration (bare runner) because files.js imports bare-fs and won't load under node.
test('peerFileStatus resolves every (downloaded/pending/online) combination', (t) => {
  // downloaded wins outright, regardless of pending state or owner presence.
  t.is(peerFileStatus(COPY_VERDICT.VERIFIED, null, true), 'downloaded')
  t.is(peerFileStatus(COPY_VERDICT.VERIFIED, { errorCode: 'X' }, false), 'downloaded', 'downloaded beats a pending error')
  t.is(peerFileStatus(COPY_VERDICT.UNPROVEN, null, true), 'downloaded', 'an unproven copy is still on the device')
  t.is(peerFileStatus(COPY_VERDICT.MODIFIED, null, true), 'modified', 'a copy edited since it was verified is modified')
  t.is(peerFileStatus(COPY_VERDICT.MODIFIED, { errorCode: 'X' }, false, true), 'modified', 'and that beats a pending row and a fetch')

  // not downloaded, with a pending row.
  t.is(peerFileStatus(null, { errorCode: 'X' }, true), 'error', 'a pending error wins over paused')
  t.is(peerFileStatus(null, { bytesTransferred: 10 }, true), 'paused-interrupted', 'paused + owner online')
  t.is(peerFileStatus(null, { bytesTransferred: 10 }, false), 'paused-offline', 'paused + owner offline')

  // not downloaded, no pending row.
  t.is(peerFileStatus(null, undefined, true), 'remote', 'available from an online owner')
  t.is(peerFileStatus(null, undefined, false), 'unavailable', 'owner offline, nothing local')

  // A clean pending row (no errorCode) from an offline owner is paused-offline, never
  // error — the contract the seeder-quit fix relies on (the engine records no errorCode
  // for a vanished holder, so this branch is the one reached).
  t.is(peerFileStatus(null, { bytesTransferred: 100 }, false), 'paused-offline',
    'a clean pending row from an offline owner is paused-offline, never failed')
})

// The worker owns the 'downloading' state now (single source of truth): an in-flight fetch is
// 'downloading' regardless of the durable pending row or presence, so the renderer never has to
// synthesise it (and can never latch a stale paused-offline over it).
test('REGRESSION (FIX-EDA-1: an active fetch is downloading, never paused/remote)', (t) => {
  t.is(peerFileStatus(null, { bytesTransferred: 10 }, true, true), 'downloading',
    'active + owner online → downloading, not paused-interrupted')
  t.is(peerFileStatus(null, { bytesTransferred: 10 }, false, true), 'downloading',
    'active + owner offline → downloading, not paused-offline (no stale owner-offline latch)')
  t.is(peerFileStatus(null, { errorCode: 'X' }, true, true), 'downloading',
    'active beats a stale pending errorCode')
  t.is(peerFileStatus(null, null, false, true), 'downloading',
    'active with no pending row is still downloading')
  // downloaded still wins even over an active flag (a just-completed row).
  t.is(peerFileStatus(COPY_VERDICT.VERIFIED, null, true, true), 'downloaded')
})
