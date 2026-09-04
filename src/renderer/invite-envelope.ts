// The invite codec is one declaration in the contract package now. This file remains as the
// renderer's import path; the hand-maintained copy it used to hold could not read the creator,
// schema version, auto-admit or invite-id fields at all, and silently dropped them.
export { decodeInvite, extractInviteCode } from '../shared/contract/invite-envelope.js'
