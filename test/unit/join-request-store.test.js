import test from 'brittle'
import {
  recordJoinRequest, getJoinRequestDriveKey, listJoinRequests, clearJoinRequest,
} from '../../src/shared/spaces/space.js'

// A driveKey-bearing record is a materialized member converging (captured from a handshake), not
// an approvable join request: its driveKey is retained so a co-member can admit it once the
// approval record converges, but it must NOT be listed as a request (else a co-member could
// "approve" a peer who already joined). A genuine no-driveKey joiner is still listed.
test('a drive-holder is captured for convergence but not listed as an approvable request', (t) => {
  const sid = 'unit-jr-space'
  const jk = 'b'.repeat(64)
  const dk = 'c'.repeat(64)
  const jk2 = 'd'.repeat(64)

  recordJoinRequest(sid, jk, 'Bob', null, dk)
  t.is(getJoinRequestDriveKey(sid, jk), dk, 'driveKey captured for convergence')
  t.absent(listJoinRequests(sid).some((r) => r.publicKey === jk), 'a drive-holder is NOT listed as a request')

  recordJoinRequest(sid, jk2, 'Carol', null, null)
  t.ok(listJoinRequests(sid).some((r) => r.publicKey === jk2), 'a genuine no-driveKey joiner IS listed')

  recordJoinRequest(sid, jk, 'Bob', null, null)
  t.is(getJoinRequestDriveKey(sid, jk), dk, 'driveKey preserved across a re-record without one')

  t.ok(clearJoinRequest(sid, jk), 'clear returns true when a request existed')
  t.absent(clearJoinRequest(sid, jk), 'clear returns false when none existed')
  t.is(getJoinRequestDriveKey(sid, jk), null, 'driveKey gone after clear')
})
