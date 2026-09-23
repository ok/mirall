// The interactive member fan-out every "own record plus every member's" listing runs: the peers of a
// space minus ourselves, every read started at once under ONE short budget. `readOne(peer, budget)`
// bounds its own read by that budget and settles to its empty value when the peer fails, so the
// listing costs one budget in total however many members are unreachable.
import { interactiveReadTimeoutMs } from '../core/with-timeout.js'

// `admit` narrows to the members a caller can read at all (a listing that needs a catalog key).
export function peerMembersOf(members, me, admit = () => true) {
  return (members || []).filter((m) => m?.publicKey && m.publicKey !== me && admit(m))
}

export function readEachPeer(peers, readOne, { budget = interactiveReadTimeoutMs() } = {}) {
  return Promise.all(peers.map((peer) => readOne(peer, budget)))
}
