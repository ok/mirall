// The event plane: what a pushed frame is, who it reaches, and what a client that was away can get
// back. Split from the router because it is a whole half of the wire — the router's other job is
// turning a request frame into an answer, and the two share only the client set.
import { Scope } from '../contract/scope.js'
import { TARGETED_EVENTS, isEphemeralEvent } from '../contract/events.js'
import { MAIN_REQUEST_FRAME } from '../contract/main-requests.js'
import { createHintBus } from './hints.js'
import { createReplayRing } from './replay-ring.js'

// Fan a coalesced `event:reconcile` out of a POKE so its view re-derives through the level-triggered
// reconcile channel. The named events stay on the wire as the emit-site API (and as flow-test /
// debugging observables); the reconcile-driven hooks (useFiles, useShareFiles, useMembers, useShares,
// useSpaces) no longer subscribe to them. Every row here must have a consumer matching that scope
// kind, and every hook that re-derives on a hint must have its poke sources mapped here.
// event:member-joined is deliberately unmapped: it fires pre-persist; members-updated (post-persist)
// is the poke. Owned/foreign mount-status both map to the shares scope (both persist a durable
// mount.status the consumer re-derives, and the listings they re-read carry lastError, so the
// transient paused-error state arrives with them — neither consumer needs a named subscription).
const POKE_SCOPE = {
  'event:files-updated': (p) => (p.spaceId ? Scope.files(p.spaceId) : null),
  'event:shares-updated': (p) => (p.spaceId ? Scope.shares(p.spaceId) : null),
  // shareId may be absent (a space-wide poke) — the hint is then a wildcard on the share
  // axis and matches every share view in the space (scope-match contract).
  'event:share-files-updated': (p) => (p.spaceId ? Scope.shareFiles(p.spaceId, p.shareId) : null),
  'event:members-updated': (p) => (p.spaceId ? Scope.members(p.spaceId) : null),
  'event:mirrors-updated': (p) => (p.spaceId ? Scope.mirrors(p.spaceId, p.shareId) : null),
  'event:member-left': (p) => (p.spaceId ? Scope.members(p.spaceId) : null),
  'event:member-avatar-updated': (p) => (p.spaceId ? Scope.members(p.spaceId) : null),
  'event:member-join-request': (p) => (p.spaceId ? Scope.joinRequests(p.spaceId) : null),
  'event:join-requests-updated': (p) => (p.spaceId ? Scope.joinRequests(p.spaceId) : null),
  'event:foreign-folder-mount-status': (p) => (p.spaceId ? Scope.shares(p.spaceId) : null),
  'event:owned-folder-mount-status': (p) => (p.spaceId ? Scope.shares(p.spaceId) : null),
  'event:audit-updated': () => Scope.audit(),
}

/** @internal */
export function scopeForEvent(type, payload = {}) {
  const toScope = POKE_SCOPE[type]
  return toScope ? toScope(payload) : null
}

const TARGETED = new Set(TARGETED_EVENTS)

export function createEventPlane({ clients, log, epoch, replay }) {
  // Every pushed frame is numbered, so a client that was away can say where it got to. One counter
  // for the whole router: a per-client one would make "seq 40" mean two different frames, which is
  // the same mistake request ids made before #402.
  //
  // `epoch` changes with the process. Without it a cursor of 40 against a restarted worker now at
  // 60 would read as in-range and silently skip forty unrelated frames.
  let seq = 0
  const ring = createReplayRing(replay)
  let seqCollisionWarned = false

  // emit(type, payload)          → every client
  // emit(type, payload, { to })  → one client, by object or by id
  //
  // One method rather than emit + emitTo: the contract guards find emit sites by parsing for a
  // callee named `emit` with the event name first (test/helpers/emit-sites.js), and a second
  // spelling would hide every targeted event from "is every declared event emitted somewhere".
  function emit(type, payload = {}, { to = null } = {}) {
    // Not an event: main consumes this off the same pipe and no subscribing client ever sees it, so
    // it takes no ordinal and is never replayed.
    if (type === MAIN_REQUEST_FRAME) {
      const line = JSON.stringify({ type, ...payload }) + '\n'
      for (const client of clients.all()) client.write(line)
      return
    }
    if (TARGETED.has(type) && to == null) {
      // One caller's progress must never land in another's UI. Dropped with a warn rather than
      // thrown: leave-progress fires from a teardown that outlives its own request, and a throw
      // there is an unhandled rejection inside the crash backstop's fault window. The static guard
      // (test/invariants/targeted-events.test.js) is what stops a new call site shipping like this.
      log.warn('targeted event emitted with no target, dropped:', type)
      return
    }
    if (!isEphemeralEvent(type)) log.debug('emit', type)
    // `seq` goes LAST so it wins the spread. The frame is { type, ...payload }, and a payload field
    // of that name would otherwise silently replace the ordinal with something that is not one.
    if (payload && 'seq' in payload && !seqCollisionWarned) {
      seqCollisionWarned = true
      log.warn('event payload carries a `seq` field, which the frame ordinal overwrites:', type)
    }
    // Captured, not re-read: the ring is keyed on this exact frame's ordinal, and anything that
    // re-entered emit() between here and the push below would file this line under a later number.
    const n = ++seq
    const line = JSON.stringify({ type, ...payload, seq: n }) + '\n'
    if (to != null) {
      // A target that has since disconnected is a silent no-op, not an error: the operation it was
      // reporting on outlives the client that asked for it.
      clients.resolve(to)?.write(line)
      return
    }
    for (const client of clients.all()) client.write(line)
    // Only broadcasts are kept. A targeted frame is one caller's progress, and replaying it to
    // another client would be answering a question nobody asked.
    if (!isEphemeralEvent(type)) ring.push(n, line)
    // Hints fan out of broadcasts only: a targeted event says nothing about state anyone
    // else re-derives.
    const scope = scopeForEvent(type, payload)
    if (scope) hintBus.hint(scope)
  }

  // Catch a client up from its cursor. The replayed lines are written BEFORE this returns and the
  // router answers after the handler resolves, so on the client's ordered pipe the replay always
  // precedes the answer describing it.
  function resume(client, { epoch: theirs = null, since = 0 } = {}) {
    const head = seq
    // No epoch at all is a first-time subscriber: it has missed nothing because it has seen
    // nothing. A DIFFERENT epoch is a worker that restarted under it, and only a resync is honest.
    if (theirs !== epoch) return { epoch, head, gap: theirs != null, replayed: 0 }
    // A cursor ahead of the stream is one this worker never issued. Under a matching epoch that is
    // impossible from an honest client, so the only safe answer is that it cannot be caught up.
    if (since > head) return { epoch, head, gap: true, replayed: 0 }
    const lines = ring.since(since)
    if (lines === null) return { epoch, head, gap: true, replayed: 0 }
    // Only up to where the client joined. It has been receiving broadcasts live since then, and
    // sending those again would put an older ordinal after a newer one on its pipe — which is
    // exactly what a client using the sequence to dedupe cannot survive.
    const missed = lines.filter((line) => frameSeq(line) <= client.attachedAt)
    for (const line of missed) client.write(line)
    return { epoch, head, gap: false, replayed: missed.length }
  }

  // The ordinal is the last field of a frame the plane itself serialised, so this reads it back
  // without parsing the whole line.
  function frameSeq(line) {
    const at = line.lastIndexOf('"seq":')
    return at === -1 ? 0 : Number.parseInt(line.slice(at + 6), 10)
  }

  // Through emit(), not straight at a pipe: the hint bus was the second write site on the wire, and
  // a second site is one every later frame-level change has to remember. There is no recursion —
  // scopeForEvent('event:reconcile') is null.
  const hintBus = createHintBus((t, p) => emit(t, p))

  return { emit, resume, epoch, head: () => seq, hintBus }
}
