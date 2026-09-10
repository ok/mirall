import test from 'brittle'
import b4a from 'b4a'
import { sanitizeAvatar } from '../../src/shared/identity-limits.js'
import { NAME_MAX, JOIN_REQUEST_FRAME_OVERHEAD } from '../../src/shared/contract/limits.js'
import {
  getRuntimeConfig, setRuntimeConfig, getPeerFrameMaxBytes, getResourceCaps, joinRequestAvatarMaxBytes,
} from '../../src/shared/core/runtime-config.js'

function withConfig (t, patch) {
  const prev = { ...getRuntimeConfig() }
  setRuntimeConfig({ ...prev, ...patch })
  t.teardown(() => setRuntimeConfig(prev))
}

const hex = (n) => 'a'.repeat(n)
const avatarOf = (bytes) => 'data:image/png;base64,' + 'A'.repeat(bytes - 'data:image/png;base64,'.length)

// The membership:request frame swarm.js builds, at its worst case: a NAME_MAX display name whose
// every character is multi-byte, hex64 profileKey/spaceTopic/inviteId/signerKey/signerNs and the
// hex128 ed25519 binding signature.
function maximalRequestFrame (avatar) {
  return JSON.stringify({
    type: 'membership:request',
    profileKey: hex(64),
    displayName: 'ä'.repeat(NAME_MAX),
    avatar,
    spaceTopic: hex(64),
    inviteId: hex(64),
    sig: hex(128),
    signerKey: hex(64),
    signerNs: hex(64),
  })
}

test('the reserved frame overhead really covers the non-avatar fields', (t) => {
  const bytes = b4a.byteLength(maximalRequestFrame(null))
  t.is(bytes, 752, 'the measured worst case is unchanged')
  t.ok(bytes < JOIN_REQUEST_FRAME_OVERHEAD, 'and it fits inside the reserved overhead')
})

// REGRESSION (FIX-AVFRAME-1: an avatar between the frame cap and the storage cap rode inline in
// membership:request, so every recipient dropped the join request unparsed — the owner saw no
// request to approve and the joiner stayed pending forever, with the only trace a warn line in
// the RECEIVER's log.)
test('REGRESSION (FIX-AVFRAME-1): an over-budget avatar is dropped, and the frame fits', (t) => {
  const oversize = avatarOf(200 * 1024)
  t.is(sanitizeAvatar(oversize, getResourceCaps().avatarMaxBytes), oversize,
    'the storage cap would have accepted it — this is the gap the bug lived in')

  const clamped = sanitizeAvatar(oversize, joinRequestAvatarMaxBytes())
  t.is(clamped, null, 'the frame budget rejects it')
  t.ok(b4a.byteLength(maximalRequestFrame(clamped)) <= getPeerFrameMaxBytes(),
    'so the assembled frame is under the cap the receiver charges it against')
})

// REGRESSION (FIX-AVFRAME-2: the fix must degrade only what cannot fit.)
test('REGRESSION (FIX-AVFRAME-2): an avatar within the budget survives the clamp', (t) => {
  const ok = avatarOf(60 * 1024)
  t.is(sanitizeAvatar(ok, joinRequestAvatarMaxBytes()), ok, 'a legitimate avatar still travels')
  t.ok(b4a.byteLength(maximalRequestFrame(ok)) <= getPeerFrameMaxBytes(),
    'and the frame carrying it is still under the cap')
})

test('the budget is the frame cap minus the reserved overhead', (t) => {
  t.is(joinRequestAvatarMaxBytes(), getPeerFrameMaxBytes() - JOIN_REQUEST_FRAME_OVERHEAD,
    'default: 64512 bytes against a 262144 storage cap')

  withConfig(t, { peerFrameMaxBytes: 0 })
  t.is(joinRequestAvatarMaxBytes(), getResourceCaps().avatarMaxBytes,
    'frame cap disabled → nothing to budget against, fall back to the storage cap')

  setRuntimeConfig({ ...getRuntimeConfig(), peerFrameMaxBytes: 512 })
  t.is(joinRequestAvatarMaxBytes(), 1,
    'a frame cap below the overhead clamps to 1, not 0 — 0 would read downstream as "no bound"')
  t.is(sanitizeAvatar(avatarOf(64), joinRequestAvatarMaxBytes()), null,
    'and 1 byte admits nothing, since it is shorter than the data-URI prefix')
})
