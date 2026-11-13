// What this install tells its organization: enrolled once with the license, then a report on start,
// on every applied change, every 24 h and on Leave. Never blocking: an unreachable Console delays the
// next report and changes nothing the app applies. A report is a snapshot, so a failed one is
// replaced by the next, never queued.
//
// One request at a time, and each start or stop opens a new generation: a request still answering
// for an earlier one changes nothing, so a report for the previous license never touches the next
// one's key, and a stopped reporter never retries.
import sodium from 'sodium-native'
import b4a from 'b4a'
import { enrollKeyPair } from '../../shared/managed/derive.js'
import { CALL, NONCE_BYTES, enrollBody, instanceKeyPair, reportBody, signedHeaders } from '../../shared/managed/upward.js'
import { postUpward } from '../../shared/managed/upward-client.js'
import { readInstanceKey, removeInstanceKey, writeInstanceKey } from '../../shared/managed/instance-key.js'
import { effectiveApiUrl } from '../../shared/managed/managed-state.js'

const REPORT_EVERY_MS = 24 * 60 * 60_000
const CHANGE_DEBOUNCE_MS = 2000
const FIRST_RETRY_MS = 60_000
const REQUEST_TIMEOUT_MS = 15_000
const LEAVE_BUDGET_MS = 5000
const MIN_REQUEST_MS = 1000

const hex = (buf) => b4a.toString(buf, 'hex')
const random = (n) => {
  const out = b4a.alloc(n)
  sodium.randombytes_buf(out)
  return out
}
const enrollKeyHex = (state) => hex(enrollKeyPair(b4a.from(state.licenseKey, 'hex')).publicKey)

export class InstanceReporter {
  constructor({ storage, timers, log, getState, facts, onRevoked }) {
    this.storage = storage
    this.timers = timers
    this.log = log
    this.getState = getState
    this.facts = facts
    this.onRevoked = onRevoked
    this.instance = null
    this.offsetSeconds = 0
    this.leftSent = false
    this.stopped = true
    this.generation = 0
    this.timer = null
    this.failures = 0
    this.dirty = false
    this.sending = Promise.resolve()
    this.writes = Promise.resolve()
  }

  get revoked() {
    return this.instance?.revoked === true
  }

  // A revoked license stays revoked across restarts: it is shown at once and nothing more is sent.
  async start(state, { delayMs }) {
    this.stop()
    this.stopped = false
    this.leftSent = false
    this.failures = 0
    this.dirty = false
    await this.keyFor(state)
    if (!this.revoked) this.schedule(delayMs)
  }

  stop() {
    this.stopped = true
    this.generation += 1
    this.timers.clear(this.timer)
    this.timer = null
  }

  changed() {
    if (this.stopped || this.revoked) return
    this.dirty = true
    this.schedule(CHANGE_DEBOUNCE_MS)
  }

  // Tried within one short budget: Leave goes ahead whatever the answer, and the Console marks a
  // computer it stops hearing from dormant. A report still in flight lands first, so `left` always
  // carries the higher counter. A Leave retried after the left report landed sends nothing.
  async leave(state) {
    this.stop()
    if (this.leftSent) return
    if (!this.instance) this.instance = this.matching(state)
    if (!this.instance || this.revoked) return
    const deadline = Date.now() + LEAVE_BUDGET_MS
    const idle = await this.idleWithin(LEAVE_BUDGET_MS)
    const remaining = deadline - Date.now()
    if (!idle || remaining < MIN_REQUEST_MS) {
      this.log.warn('left report not sent: a report was still in flight')
      return
    }
    try {
      const outcome = await this.send(state, 'left', remaining, this.generation)
      if (outcome.kind === 'ok' || outcome.kind === 'revoked') this.leftSent = true
      else this.log.warn('left report not delivered:', outcome.detail)
    } catch (err) {
      this.log.warn('left report not sent:', err.message)
    }
  }

  async forget() {
    this.stop()
    this.instance = null
    await this.writes.catch(() => {})
    await removeInstanceKey(this.storage)
  }

  idleWithin(ms) {
    let timer = null
    const waited = new Promise((resolve) => { timer = this.timers.setTimeout(() => resolve(false), ms) })
    return Promise.race([this.sending.then(() => true), waited]).finally(() => this.timers.clear(timer))
  }

  matching(state) {
    const stored = readInstanceKey(this.storage)
    return stored?.enrollPublicKey === enrollKeyHex(state) ? stored : null
  }

  // One key per license: a key enrolled with another license is replaced, never re-enrolled.
  async keyFor(state) {
    const stored = this.matching(state)
    if (stored) {
      this.instance = stored
      return
    }
    this.instance = { seed: hex(random(32)), enrollPublicKey: enrollKeyHex(state), counter: 0, enrolled: false, revoked: false }
    await this.persist()
  }

  persist() {
    const snapshot = { ...this.instance }
    this.writes = this.writes.catch(() => {}).then(() => writeInstanceKey(this.storage, snapshot))
    return this.writes
  }

  schedule(delayMs) {
    this.timers.clear(this.timer)
    const generation = this.generation
    this.timer = this.timers.setTimeout(() => {
      this.timer = null
      this.sending = this.sending.then(() => this.tick(generation)).catch((err) => this.log.warn('report failed:', err.message))
    }, delayMs)
  }

  // A change that arrives while a report is answering is reported after it, not left for a day.
  async tick(generation) {
    const state = this.getState()
    if (generation !== this.generation || !state || !this.instance) return
    this.dirty = false
    let outcome
    try {
      outcome = await this.send(state, 'managed', REQUEST_TIMEOUT_MS, generation)
    } catch (err) {
      outcome = { kind: 'retry', afterMs: null, detail: err.message }
    }
    if (generation !== this.generation || outcome.kind === 'stale') return
    if (outcome.kind === 'revoked') {
      this.instance = { ...this.instance, revoked: true }
      await this.persist().catch((err) => this.log.warn('revoked state not stored:', err.message))
      this.onRevoked()
      return
    }
    if (outcome.kind === 'retry') {
      const backoff = outcome.afterMs ?? FIRST_RETRY_MS * 2 ** this.failures
      this.failures += 1
      this.log.warn('report not delivered, retrying:', outcome.detail)
      this.schedule(Math.min(backoff, REPORT_EVERY_MS))
      return
    }
    if (outcome.kind === 'refused') this.log.warn('report refused:', outcome.detail)
    this.failures = 0
    this.schedule(this.dirty ? CHANGE_DEBOUNCE_MS : REPORT_EVERY_MS)
  }

  // A wrong clock is corrected from the Console's time and tried once more; a key the Console does
  // not know enrolls again.
  async send(state, reportState, timeoutMs, generation) {
    let enroll = !this.instance.enrolled
    let skewRetried = false
    for (;;) {
      const res = await this.post(state, reportState, enroll, timeoutMs)
      if (generation !== this.generation) return { kind: 'stale' }
      if (res.status >= 200 && res.status < 300) {
        if (enroll) {
          this.instance = { ...this.instance, enrolled: true }
          await this.persist()
        }
        return { kind: 'ok' }
      }
      if (res.error === 'clock_skew' && res.serverTime !== null && !skewRetried) {
        this.offsetSeconds = res.serverTime - Math.floor(Date.now() / 1000)
        skewRetried = true
        continue
      }
      if (res.error === 'unknown_instance' && !enroll) {
        enroll = true
        continue
      }
      if (res.status === 410) return { kind: 'revoked' }
      const detail = res.status ? `${res.status} ${res.error ?? ''}`.trim() : res.error
      if (res.status === 0 || res.status === 429 || res.status >= 500) return { kind: 'retry', afterMs: res.retryAfterMs, detail }
      return { kind: 'refused', detail }
    }
  }

  // Every request carries a counter above any this install sent before, taken before any await and
  // stored before it goes out: an equal or lower one can only come from a second computer holding a
  // copy of this key.
  async post(state, reportState, enroll, timeoutMs) {
    const instance = { ...this.instance, counter: this.instance.counter + 1 }
    this.instance = instance
    await this.persist()
    const keyPair = instanceKeyPair(b4a.from(instance.seed, 'hex'))
    const timestamp = Math.floor(Date.now() / 1000) + this.offsetSeconds
    const nonce = random(NONCE_BYTES)
    const report = reportBody({ ...this.facts(state), state: reportState, reportCounter: instance.counter })
    const call = enroll ? CALL.ENROLL : CALL.REPORT
    const payload = enroll
      ? enrollBody({ enrollKeys: enrollKeyPair(b4a.from(state.licenseKey, 'hex')), instanceKey: keyPair.publicKey, timestamp, nonce, report })
      : report
    const body = b4a.from(JSON.stringify(payload))
    const headers = signedHeaders({ call, keyPair, timestamp, nonce, body })
    return postUpward({ apiUrl: effectiveApiUrl(state), call, headers, body, timers: this.timers, timeoutMs: Math.max(MIN_REQUEST_MS, timeoutMs) })
  }
}
