// Reading another peer's profile bee.
//
// One bounded read, one budget: the session is opened by key, its head pulled, the read run and
// the session closed — all under a single deadline covering both phases, because a peer that is
// merely slow and a peer that is gone look identical until the budget expires. Every public
// reader in profile.js goes through withPeerBee and none adds a second budget of its own.

import { createLogger } from '../core/logger.js'

import { mapLimit } from '../core/concurrency.js'
import { getCaptureMemberRecordMs, getMembershipCaps } from '../core/runtime-config.js'
import { getStore } from '../core/store.js'
import { peerReadTimeoutMs, withReadTimeout } from '../core/with-timeout.js'
import b4a from 'b4a'
import Hyperbee from 'hyperbee'

const log = createLogger('peer-bee')

// `timeoutMs` is a SESSION-level hypercore timeout: every block read under this session (and the
// snapshot sessions hyperbee opens per get) settles with REQUEST_TIMEOUT instead of waiting for a
// block that may never arrive, so an abandoned read cannot pin the core through a hung batch. 0
// keeps hypercore's default (wait forever), which the long-lived holders want. `active:false` opts
// the session out of the core's replicator activity, so corestore's per-connection attach pass does
// not force-attach it to every open muxer; a read that needs blocks must stay active or never gets them.
export function openProfileBee(publicKeyBuffer, { timeoutMs = 0, active = true } = {}) {
  const store = getStore()
  const opts = { key: publicKeyBuffer, ...(timeoutMs ? { timeout: timeoutMs } : {}), ...(active ? {} : { active: false }) }
  const core = (timeoutMs || !active) ? store.get(opts) : store.get(publicKeyBuffer)
  return new Hyperbee(core, {
    keyEncoding: 'utf-8',
    valueEncoding: 'json',
  })
}

// Bounded head refresh: race update() against `ms` so an already-up-to-date core (no upgrade
// coming) can't hang the caller on update({ wait: true }).
async function boundedUpdate(core, ms) {
  await withReadTimeout(core.update({ wait: true }).catch(() => {}), ms, undefined)
}

// One bounded read of a peer's profile bee: open, pull the head, run `fn`, close. Closing releases
// only THIS session; the core stays open for every other holder (a member view's follow, the avatar
// listener), and corestore reclaims it on idle GC once the last session goes, which also takes it
// off every replication stream. A close while update() is in flight cancels it (REQUEST_CANCELLED),
// which callers already map to the fallback. One budget covers the head sync and the read together,
// so a caller's deadline is charged once rather than once per phase.
export async function withPeerBee(profileKeyHex, fn, {
  timeoutMs = peerReadTimeoutMs(),
  fallback = null,
  sync = true,
} = {}) {
  // A read that does not sync is answerable from local blocks by construction, so its session has
  // no reason to advertise the core to every connected peer for the length of the read.
  const active = sync
  const deadline = Date.now() + timeoutMs
  let bee = null
  try {
    // Inside the try: a malformed key or a store closing during shutdown must degrade to the
    // fallback like any other unreadable peer, not reject into a caller that has no catch
    // (buildWantedKeys awaits this bare, and one throw would abort the whole leftover scan).
    bee = openProfileBee(b4a.from(profileKeyHex, 'hex'), { timeoutMs, active })
    await bee.ready()
    if (sync) await boundedUpdate(bee.core, Math.max(0, deadline - Date.now()))
    return await withReadTimeout(fn(bee), Math.max(0, deadline - Date.now()), fallback)
  } catch (err) {
    // Say it: without this the callers' own catch/log lines are unreachable, and a real bug in
    // `fn` (a bad key encoding, a decode failure) is indistinguishable from "peer offline".
    log.debug('peer bee read failed for', profileKeyHex.slice(0, 16) + '...', '-', err.message)
    return fallback
  } finally {
    if (bee) await bee.close().catch(() => {})
  }
}

// Copy a peer's profile bee to a CONTIGUOUS local prefix using EXPLICIT block gets, so
// enforcement reads stay answerable from a local snapshot after the author goes offline.
// A contiguous prefix is what makes offline snapshot reads sound: a checkout at
// contiguousLength only ever touches local blocks. Idempotent — gets on local blocks skip
// the network, so re-running is cheap. `complete` means the prefix this capture will ever hold
// is contiguous, which for a bee past the sweep cap is the capped prefix; `capped` marks such a
// bee (records past the cap are not snapshot-readable — surfaced as a warn).
export async function capturePeerBee(profileKeyHex, {
  deadline = Date.now() + getCaptureMemberRecordMs(),
  maxBlocks = getMembershipCaps().peerBeeCaptureMaxBlocks,
  parallel = 8,
} = {}) {
  const bee = openProfileBee(b4a.from(profileKeyHex, 'hex'))
  try {
    await bee.ready()
    const core = bee.core
    try {
      // At most a second waiting for the peer's head, however much of the budget is left: the
      // sweep below is the part that needs the time, and a peer that has not answered by now is
      // offline rather than slow.
      await boundedUpdate(core, Math.min(1000, Math.max(0, deadline - Date.now())))
      const target = Math.min(core.length, maxBlocks)
      await sweepBlocks(core, target, parallel, deadline)
      const verdict = captureVerdict({ length: core.length, contiguousLength: core.contiguousLength, maxBlocks })
      if (verdict.capped) log.warn(`peer-bee exceeds the capture cap — ${profileKeyHex.slice(0, 8)} len=${core.length} cap=${maxBlocks}; records past the cap are not readable offline`)
      return verdict
    } catch (err) {
      log.debug(`peer-bee capture incomplete — ${profileKeyHex.slice(0, 8)} len=${core.length} contig=${core.contiguousLength}: ${err?.message || err}`)
      return { complete: false, capped: false, contiguous: core.contiguousLength, length: core.length }
    }
  } catch {
    return { complete: false, capped: false, contiguous: 0, length: 0 }
  } finally {
    await bee.close().catch(() => {})
  }
}

// The verdict of one sweep, from the lengths it left behind. `capped` is the cap alone: the bee is
// longer than the sweep budget. `complete` is decided against the length the bee has NOW, bounded
// by the cap, so a bee that grew while the sweep ran — past the cap or not — stays incomplete
// until a later sweep has captured the tail it still owes.
export function captureVerdict({ length, contiguousLength, maxBlocks }) {
  const capped = length > maxBlocks
  const complete = length > 0 && contiguousLength >= Math.min(length, maxBlocks)
  return { complete, capped, contiguous: contiguousLength, length }
}

function sweepBlocks(core, target, parallel, deadline) {
  const indices = []
  for (let i = core.contiguousLength; i < target; i++) indices.push(i)
  return mapLimit(indices, parallel, (i) => {
    if (Date.now() >= deadline) return null
    const budget = Math.min(Math.max(1000, deadline - Date.now()), 2500)
    return core.get(i, { timeout: budget })
  })
}

// Length of a peer's bee as currently known locally. The session is opened on an
// already-cached core (the member view follows it), so `length` reads synchronously;
// close it anyway — corestore tracks a session per get() until it is closed.
export async function peerBeeLength(profileKeyHex) {
  let bee
  try {
    bee = openProfileBee(b4a.from(profileKeyHex, 'hex'))
    await bee.ready()
    return bee.core.length
  } catch {
    return 0
  } finally {
    if (bee) await bee.close().catch(() => {})
  }
}

// Per-key scheduler for peer-bee captures: single-flight, throttled, and re-armed when
// the peer's core grew past what we captured. Pure factory — capture/coreLength are
// injected (profile.js wires the real ones in member-registry), so the policy is
// unit-testable without a store.
export function makeCaptureScheduler({ capture, coreLength, retryMinMs = 30_000, now = Date.now, onError = () => {} }) {
  const state = new Map()

  // Growth is measured against the length SEEN by the last capture attempt (not the
  // contiguous progress): an incomplete capture is throttled like any other retry,
  // while a genuinely appended core bypasses the window.
  const grew = (key, s) => s.seenLength != null && s.knownLength > s.seenLength

  // A capture settles on `complete` alone: for a bee past the sweep cap that is the capped
  // prefix, so it retires like any other complete one instead of retrying forever.
  function schedule(key) {
    let s = state.get(key)
    if (!s) {
      s = { inFlight: false, attempted: false, lastAt: 0, seenLength: null, knownLength: 0, complete: false }
      state.set(key, s)
    }
    if (s.inFlight) return false
    if (s.complete && !grew(key, s)) return false
    if (s.attempted && now() - s.lastAt < retryMinMs && !grew(key, s)) return false
    s.inFlight = true
    s.attempted = true
    s.lastAt = now()
    Promise.resolve()
      .then(() => capture(key))
      .then((r) => {
        s.complete = !!r?.complete
        s.seenLength = r?.length ?? s.seenLength
      })
      .catch((err) => onError(key, err))
      .finally(() => { s.inFlight = false })
    return true
  }

  // Refresh each tracked key's known length, then report the keys worth re-capturing.
  // Async because reading a peer core's length opens (and closes) a session.
  async function incomplete() {
    const out = []
    for (const [key, s] of state) {
      if (s.inFlight) continue
      try { s.knownLength = await coreLength(key) } catch { /* keep the last known length */ }
      if (!s.complete || grew(key, s)) out.push(key)
    }
    return out
  }

  function forget(key) {
    state.delete(key)
  }

  function clear() {
    state.clear()
  }

  return { schedule, incomplete, forget, clear }
}
