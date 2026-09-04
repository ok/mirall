// The invite envelope is one declaration in the contract package now, reachable from the worker,
// the renderer and main alike. This file stays as the data layer's import path; adding logic here
// would recreate the drift the move deleted.
export { decodeInvite, encodeInvite, extractInviteCode, HEX64, NAME_MAX } from './contract/invite-envelope.js'
