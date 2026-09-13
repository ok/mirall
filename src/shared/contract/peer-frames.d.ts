// Generated from peer-frames.js — contract-declarations.test.js asserts the two agree.
export declare const PEER_FRAME: Readonly<{
  HANDSHAKE: 'handshake'
  PRESENCE: 'presence'
  LEAVE: 'leave'
  LEAVE_ACK: 'leave-ack'
  MEMBERSHIP_REQUEST: 'membership:request'
  MEMBERSHIP_GRANT: 'membership:grant'
  MEMBERSHIP_DENY: 'membership:deny'
  MEMBERSHIP_CANCEL: 'membership:cancel'
  MEMBERSHIP_CANCEL_ACK: 'membership:cancel-ack'
  SHARE_INDEX_PROGRESS: 'share-index-progress'
  SHARE_PREPARE_PROGRESS: 'share-prepare-progress'
}>
export declare const PEER_FRAMES: readonly ['handshake', 'presence', 'leave', 'leave-ack', 'membership:request', 'membership:grant', 'membership:deny', 'membership:cancel', 'membership:cancel-ack', 'share-index-progress', 'share-prepare-progress']
export declare const IDENTITY_ASSERTING: readonly ['handshake', 'membership:request']
export declare const MEMBERSHIP_CONTROL_FRAMES: readonly ['membership:request', 'membership:grant', 'membership:deny', 'membership:cancel']
