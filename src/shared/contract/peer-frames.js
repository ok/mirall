// The mirall/handshake frame vocabulary: every frame two peers exchange on the per-space control
// channel, one JSON line each. `validFrameShape` gates all of them before any property is read, and
// an unrecognised type is counted and dropped.
//
//   handshake               any peer, once per shared space on connect. Carries the sender's drive
//                           key and, optionally, its asserted creator root.
//   membership:request      a joiner asking to be admitted.
//   membership:grant        the approver's answer, carrying the space content key.
//   membership:deny         the approver's refusal.
//   membership:cancel       either side withdrawing a pending request.
//   membership:cancel-ack   the receipt for that withdrawal.
//   presence                liveness — both the heartbeat and the offline farewell.
//   share-index-progress    an owner's index progress for one share.
//   share-prepare-progress  an owner's prepare progress for one share.
//   leave                   a member announcing it has left the space.
//   leave-ack               the receipt that lets the leaver stop announcing.
//
// The content plane runs its own channel with one frame, content-hello (content-swarm.js), which is
// deliberately not in this vocabulary — a different socket, a different authorization question.
// The IPC control frames are contract/ipc-frames.js; these travel between devices, those do not.
export const PEER_FRAME = Object.freeze({
  HANDSHAKE: 'handshake',
  PRESENCE: 'presence',
  LEAVE: 'leave',
  LEAVE_ACK: 'leave-ack',
  MEMBERSHIP_REQUEST: 'membership:request',
  MEMBERSHIP_GRANT: 'membership:grant',
  MEMBERSHIP_DENY: 'membership:deny',
  MEMBERSHIP_CANCEL: 'membership:cancel',
  MEMBERSHIP_CANCEL_ACK: 'membership:cancel-ack',
  SHARE_INDEX_PROGRESS: 'share-index-progress',
  SHARE_PREPARE_PROGRESS: 'share-prepare-progress',
})

/** @internal the no-raw-literal guard's list */
export const PEER_FRAMES = Object.freeze(Object.values(PEER_FRAME))

// The two frames a peer uses to CLAIM a profileKey. Both must pass validSenderFrame and the
// signature binding that key to the connection's Noise key before anything is registered, which is
// why the check sits above the dispatch rather than in a per-frame branch. membership:grant asserts
// the GRANTER's identity instead, and the membership control handler verifies that itself, because
// a grant arrives on the connection the joiner opened.
export const IDENTITY_ASSERTING = Object.freeze([PEER_FRAME.HANDSHAKE, PEER_FRAME.MEMBERSHIP_REQUEST])

// The membership frames the worker's control handler owns. cancel-ack is absent on purpose: the
// swarm answers it itself, because it resolves a pending send rather than a membership decision.
export const MEMBERSHIP_CONTROL_FRAMES = Object.freeze([
  PEER_FRAME.MEMBERSHIP_REQUEST,
  PEER_FRAME.MEMBERSHIP_GRANT,
  PEER_FRAME.MEMBERSHIP_DENY,
  PEER_FRAME.MEMBERSHIP_CANCEL,
])
