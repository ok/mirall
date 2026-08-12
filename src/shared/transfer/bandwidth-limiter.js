// Byte-denominated token bucket pacing content-plane transfers. Distinct from
// handshake-guard's createRateLimiter, which counts EVENTS per peer for abuse control:
// this one counts BYTES, is global, and delays rather than drops.
//
// The rate is read through a getter on every call, so a settings change applies to
// in-flight transfers with no re-plumbing.
//
// FAIRNESS. One bucket paces every concurrent transfer, so the bucket — not the caller —
// decides who gets the next refill. Each consumer takes a `stream()` handle, and the split
// is DEFICIT ROUND-ROBIN over streams:
//
//   - every waiting stream accrues an equal share of each refill into a `deficit`, and is
//     granted only once its deficit covers what it asked for. Fairness is therefore in
//     BYTES, not in turns: a stream fetching 4 MB chunks is served 1/64th as often as one
//     fetching 64 KB chunks and they move the same number of bytes. Arbitrating turns
//     instead — which an earlier revision of this file did — hands a large-chunk stream
//     100% of the cap and a small-chunk one exactly zero, because chunk size is derived
//     from the file-size tier and routinely differs 64x between two concurrent transfers;
//   - `tryTake` refuses the shared bucket while any stream is waiting, so a transfer that
//     already has chunks in flight — and therefore re-enters its assign loop on every
//     arrival — cannot barge past a transfer that is waiting its turn;
//   - a grant hands the stream CREDIT, so the retry it was woken for cannot lose the bytes
//     to someone else in between.
//
// Without all three, the caller with the highest polling rate takes everything: the bucket
// refills continuously in wall-clock time, so whoever calls most often consumes each
// increment microseconds after it accrues.

// Floor for a non-zero cap, clamped here as well as in the UI. This is a USABILITY guard
// against a cap so low the app looks broken — it is NOT what keeps a chunk inside
// ChunkScheduler's idle watchdog, though it was originally documented that way. The
// arithmetic never worked: 32 KB/s x 30 s = 983,040 bytes, under the 1 MB tier-2 max chunk
// and far under the 4 MB tier-3 one. A chunk costing more than the window is safe because
// the watchdog only runs while bytes are actually outstanding with a peer (see
// ChunkScheduler._armIdleTimer), not because of this value.
export const MIN_BYTES_PER_SECOND = 32 * 1024

// Longest a waiting stream goes before the bucket re-evaluates it. Bounds how long a live
// cap change takes to reach a stream that is already parked.
const MAX_ARM_MS = 250

export function createBandwidthLimiter(getBytesPerSecond, { now = Date.now } = {}) {
  const ctx = {
    now,
    tokens: 0,
    last: now(),
    timer: null,
    destroyed: false,
    waiting: [],   // streams with a pending request, in rotation order
    cursor: 0,
    getBytesPerSecond,
  }
  ctx.rate = () => ratePerSecond(ctx)
  ctx.advance = () => advance(ctx)
  ctx.arm = () => arm(ctx)
  ctx.refund = (bytes) => refund(ctx, bytes)

  return {
    stream: () => createStream(ctx),
    isUnlimited: () => ratePerSecond(ctx) === 0,
    destroy: () => destroy(ctx),
  }
}

// 0 / negative / non-finite all mean unlimited: a corrupt value must never throttle to a
// crawl, so this fails OPEN (the inverse of the protective caps in runtime-config). A
// getter that THROWS fails open too — it runs inside a timer callback, where an escaping
// exception would both crash the worker and leave the queue with nothing to re-arm it.
function ratePerSecond(ctx) {
  let n
  try { n = ctx.getBytesPerSecond() } catch { return 0 }
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return 0
  return Math.max(n, MIN_BYTES_PER_SECOND)
}

// Move the clock forward, refill, and report the elapsed ms so the caller can hand each
// waiting stream its share. `last` advances even on a zero or BACKWARDS step, so a clock
// that jumps backwards costs one round rather than freezing the bucket until it catches up.
function advance(ctx) {
  const t = ctx.now()
  const elapsed = t - ctx.last
  ctx.last = t
  if (!(elapsed > 0)) return 0
  const bps = ratePerSecond(ctx)
  if (bps > 0) ctx.tokens = Math.min(bps, ctx.tokens + (bps * elapsed) / 1000)
  return elapsed
}

// A chunk larger than one second of budget never fits the bucket, so it is released on any
// positive balance and the deficit repaid — refusing it would stall that transfer forever.
// Deliberately NOT "wait for a full bucket": with concurrent streams the bucket never
// reaches full, because a stream with small asks drains each refill the moment it lands, so
// the large-chunk stream is starved outright (measured: 4 MB against 64 KB chunks at a
// 2 MB/s cap, the large one got 0%). The long-run rate is still exact — the borrow is repaid
// before anyone is served again — and the deficit accounting in serve() is what keeps the
// split fair, not this gate.
function bucketAllows(ctx, bytes, bps) {
  return bytes > bps ? ctx.tokens > 0 : ctx.tokens >= bytes
}

// Bytes charged for work that never happened go back to the shared bucket, not to the
// stream's credit, so a churning transfer cannot bank budget others are waiting on. Capped
// at one second like refill: returning more would let a burst of cancellations overshoot
// the cap — so churn beyond one second's worth genuinely loses the excess. Note the clamp
// is on the TOTAL, so refunding N chunks in N calls credits exactly what one summed call
// credits; summing is only cheaper, never more accurate.
function refund(ctx, bytes) {
  const bps = ratePerSecond(ctx)
  if (bps === 0 || !(bytes > 0)) return
  ctx.tokens = Math.min(bps, ctx.tokens + bytes)
}

function dropWaiting(ctx, s) {
  const i = ctx.waiting.indexOf(s)
  if (i !== -1) ctx.waiting.splice(i, 1)
}

// Hand `amount` to the stream and fire its callback. The request is cleared and the stream
// leaves the queue BEFORE the callback runs, so a callback that re-enters the limiter
// (assign -> gated -> whenAvailable) enqueues a fresh request rather than mutating the one
// being settled — which would otherwise let the credited amount drift from the debited one.
function grant(ctx, s, amount) {
  dropWaiting(ctx, s)
  const req = s.request
  s.request = null
  s.credit += amount
  if (req && req.cb) { try { req.cb() } catch {} }
  promote(ctx, s)
}

// A handle holds ONE queue entry, but take() may be called concurrently on it — the serve
// side hands a single handle to every serve loop for a peer, and protomux does not
// serialise its async onmessage handlers. Extra calls wait in the handle's own backlog and
// are promoted one at a time, so the handle never appears in ctx.waiting twice (which
// stranded the earlier entry's request as null and threw out of the pump).
function promote(ctx, s) {
  if (s.detached || ctx.destroyed || s.request || !s.backlog.length) return
  s.request = s.backlog.shift()
  ctx.waiting.push(s)
  arm(ctx)
}

// Resolve everything this handle has parked, granting nothing. Used by detach and destroy:
// an unresolved take() hangs its serve loop forever.
function abortRequests(s) {
  const reqs = s.request ? [s.request, ...s.backlog] : [...s.backlog]
  s.request = null
  s.backlog.length = 0
  for (const req of reqs) {
    if (req && req.cb) { try { req.cb() } catch {} }
  }
}

// Each waiting stream accrues an equal share of the budget that just became available.
// The ceiling stops a stream that is barely asking from banking budget, but never sits
// below its current ask or an oversized chunk could never be paid for at all.
function distribute(ctx, bps, elapsed) {
  if (!ctx.waiting.length || elapsed <= 0) return
  const share = (bps * elapsed) / 1000 / ctx.waiting.length
  for (const s of ctx.waiting) {
    // Ceiling of one second of the whole cap: a stream that is barely asking must not bank
    // budget it can later burst with. The floor is unbounded by design — a stream charged
    // for an oversized chunk owes that balance back before its next turn.
    s.deficit = Math.min(bps, s.deficit + share)
  }
}

// Grant everyone this round can pay for, rotating the starting point so no stream is
// permanently first. Restarts after each grant because the callback may have mutated the
// queue underneath us.
function serve(ctx, bps) {
  let progressed = true
  while (progressed && ctx.waiting.length) {
    progressed = false
    for (let n = 0; n < ctx.waiting.length; n++) {
      const i = (ctx.cursor + n) % ctx.waiting.length
      const s = ctx.waiting[i]
      const need = s.request.bytes
      // Eligible on a POSITIVE balance, then charged in full — so the deficit goes negative
      // and this stream waits out the repayment before its next turn. Requiring the balance
      // to cover the chunk up front instead would make time-to-first-chunk scale with chunk
      // size (a 256 KB chunk at a 32 KB/s cap would sit idle for 8 s before anything moved)
      // without buying any extra fairness: charging in full already makes the long run
      // byte-proportional.
      if (s.deficit <= 0 || !bucketAllows(ctx, need, bps)) continue
      ctx.tokens -= need
      s.deficit -= need
      ctx.cursor = i + 1
      grant(ctx, s, need)
      progressed = true
      break
    }
  }
}

function pump(ctx) {
  ctx.timer = null
  if (ctx.destroyed) return
  try {
    const bps = ratePerSecond(ctx)
    if (bps === 0) {
      // The cap was lifted while these were parked — release them all. Credit the FULL ask
      // even though nothing is charged: take() reports what it was paid, and the serve loop
      // treats 0 as "aborted, do not send". Granting 0 here made *raising* the cap abandon
      // every in-flight upload mid-batch.
      for (const s of ctx.waiting.splice(0, ctx.waiting.length)) grant(ctx, s, s.request ? s.request.bytes : 0)
      return
    }
    const elapsed = advance(ctx)
    distribute(ctx, bps, elapsed)
    serve(ctx, bps)
  } finally {
    // In a finally so a throw cannot strand the queue with no timer to wake it: `timer` is
    // already null, and nothing else re-arms.
    arm(ctx)
  }
}

// Deliberately NOT unref'd: a pending take() resolves only when this fires, so an unref'd
// timer would let an otherwise-idle loop hang the serve loop forever. It exists only while
// a transfer is actively throttled.
function arm(ctx) {
  if (ctx.timer || ctx.destroyed || !ctx.waiting.length) return
  const bps = ratePerSecond(ctx)
  if (bps === 0) { ctx.timer = setTimeout(() => pump(ctx), 1); return }
  advance(ctx)
  const share = bps / ctx.waiting.length
  let soonest = Infinity
  for (const s of ctx.waiting) {
    const need = s.request.bytes
    const forBucket = (need > bps ? -ctx.tokens : need - ctx.tokens) / bps
    // Eligibility is a positive balance (see serve), so this is the time to climb back
    // above zero, not the time to cover the whole chunk.
    const forDeficit = s.deficit > 0 ? 0 : (-s.deficit) / share
    soonest = Math.min(soonest, Math.max(forBucket, forDeficit, 0) * 1000)
  }
  const ms = Number.isFinite(soonest) ? Math.ceil(soonest) : MAX_ARM_MS
  ctx.timer = setTimeout(() => pump(ctx), Math.min(Math.max(1, ms), MAX_ARM_MS))
}

function destroy(ctx) {
  if (ctx.destroyed) return
  ctx.destroyed = true
  if (ctx.timer) { clearTimeout(ctx.timer); ctx.timer = null }
  // Settle rather than drop: a pending take() resolves only here, and leaving it unresolved
  // would hang whichever serve loop is awaiting it. Nothing can re-queue afterwards —
  // whenAvailable/take short-circuit once destroyed — so the queue cannot be left non-empty
  // with no timer, which would wedge every stream on the anti-barge rule.
  for (const s of ctx.waiting.splice(0, ctx.waiting.length)) abortRequests(s)
}

// A per-consumer handle. ONE per ChunkScheduler, and one per peer on the serve side. A
// handle carries a single pending request, so a consumer uses either the tryTake/
// whenAvailable pair (download assign loop) or take() (upload serve loop), not both.
function createStream(ctx) {
  const s = { deficit: 0, credit: 0, request: null, backlog: [], detached: false }

  function spend(bytes) {
    if (s.credit < bytes) return false
    s.credit -= bytes
    return true
  }

  const api = {
    isUnlimited: () => ratePerSecond(ctx) === 0,

    // Non-blocking — for the synchronous download-assign loop.
    tryTake(bytes) {
      if (s.detached || ctx.destroyed) return false
      const bps = ratePerSecond(ctx)
      if (bps === 0) return true
      if (spend(bytes)) return true
      if (ctx.waiting.length) return false   // anti-barge: queued streams go first
      advance(ctx)
      if (!bucketAllows(ctx, bytes, bps)) return false
      ctx.tokens -= bytes
      return true
    },

    // Whether a refused tryTake was refused for a STRUCTURAL reason — no credit and other
    // streams are queued — rather than because this particular size does not fit. The
    // assign loop uses it to stop probing smaller chunks: while the queue is non-empty no
    // size can succeed, so scanning on is pure waste on the worker's single thread.
    // Only ever consulted after tryTake returned false, which already established that the
    // rate is non-zero — so no rate lookup (and no config-object allocation) here.
    wouldBlock() {
      if (s.detached || ctx.destroyed) return true
      if (s.credit > 0) return false
      return ctx.waiting.length > 0
    },

    give(bytes) {
      refund(ctx, bytes)
    },

    // Retry hook for tryTake callers: takes a place in the queue and fires once this stream
    // has been GRANTED the bytes, not merely once they might be affordable.
    //
    // Returns whether the retry was actually registered. FALSE means nothing will ever call
    // back (the limiter is torn down, or this handle is detached), which the caller must be
    // able to tell from being paced — a scheduler that suppresses its stall watchdog while
    // paced would otherwise wait forever on a callback that cannot come.
    whenAvailable(bytes, cb) {
      if (s.detached || ctx.destroyed) return false
      if (s.request) {
        // Already queued — keep our place, and wake as early as the cheapest ask allows.
        s.request.bytes = Math.min(s.request.bytes, bytes)
        s.request.cb = cb
        return true
      }
      s.request = { bytes, cb }
      ctx.waiting.push(s)
      arm(ctx)
      return true
    },

    // Awaited before serving a chunk. Resolves with the number of bytes actually PAID FOR:
    // `bytes` normally, 0 if the wait was aborted (limiter destroyed, or the handle
    // detached because the peer went away). A caller must not send on 0 — the old
    // implementation resolved void, so an aborted wait was indistinguishable from a paid
    // one and put unmetered bytes on the wire.
    async take(bytes) {
      if (s.detached || ctx.destroyed) return 0
      const bps = ratePerSecond(ctx)
      if (bps === 0) return bytes
      if (api.tryTake(bytes)) return bytes
      return new Promise((resolve) => {
        const req = { bytes, cb: () => resolve(spend(bytes) ? bytes : 0) }
        // A handle holds one queue entry; concurrent take()s wait in its backlog. Pushing a
        // second entry for the same handle stranded the first request as null and threw out
        // of the pump — see promote().
        if (s.request) { s.backlog.push(req); return }
        s.request = req
        ctx.waiting.push(s)
        arm(ctx)
      })
    },

    // The consumer is finished (transfer done/failed/cancelled, or the peer's channel
    // closed). Give up our place in the queue, resolve anything awaiting us, and return
    // credit granted but never spent — or a cap's worth of budget leaks out of the bucket
    // on every consumer that ends mid-round. Named `detach`, not `release`: the vendored
    // engine duck-types this object, and `release(amount)` means the OPPOSITE ("add budget
    // and wake everyone") on the limiter shapes it is tested against.
    detach() {
      if (s.detached) return
      s.detached = true
      dropWaiting(ctx, s)
      s.deficit = 0
      if (s.credit > 0) { refund(ctx, s.credit); s.credit = 0 }
      abortRequests(s)   // resolves every parked take() with 0, backlog included
    },
  }

  return api
}
