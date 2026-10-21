// What this install tells its organization: enrolled once with the license, then a report on start,
// on every applied change, every 24 h and on Leave. Never blocking: an unreachable Console delays the
// next report and changes nothing the app applies. A report is a snapshot, so a failed one is
// replaced by the next, never queued.
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
const LEAVE_TIMEOUT_MS = 8000

const hex = (buf) => b4a.toString(buf, 'hex')
const random = (n) => {
  const out = b4a.alloc(n)
  sodium.randombytes_buf(out)
  return out
}

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
    this.revoked = false
    this.leftSent = false
    this.stopped = true
    this.timer = null
    this.failures = 0
    this.sending = Promise.resolve()
    this.writes = Promise.resolve()
  }

  async start(state, { delayMs }) {
    this.revoked = false
    this.leftSent = false
    this.stopped = false
    this.failures = 0
    await this.keyFor(state)
    this.schedule(delayMs)
  }

  stop() {
    this.stopped = true
    this.timers.clear(this.timer)
    this.timer = null
  }

  changed() {
    if (!this.stopped && !this.revoked) this.schedule(CHANGE_DEBOUNCE_MS)
  }

  // Tried once, briefly: Leave goes ahead whatever the answer, and the Console marks a computer it
  // stops hearing from dormant. A Leave retried after the left report landed sends nothing.
  async leave(state) {
    this.stop()
    if (this.revoked || this.leftSent) return
    if (!this.instance) this.instance = this.matching(state)
    if (!this.instance) return
    try {
      const outcome = await this.send(state, 'left', LEAVE_TIMEOUT_MS)
      if (outcome.kind === 'ok' || outcome.kind === 'revoked') this.leftSent = true
      else this.log.warn('left report not delivered:', outcome.detail)
    } catch (err) {
      this.log.warn('left report not sent:', err.message)
    }
  }

  async forget() {
    this.stop()
    this.instance = null
    await this.writes
    await removeInstanceKey(this.storage)
  }

  matching(state) {
    const stored = readInstanceKey(this.storage)
    const enrollPublicKey = hex(enrollKeyPair(b4a.from(state.licenseKey, 'hex')).publicKey)
    return stored?.enrollPublicKey === enrollPublicKey ? stored : null
  }

  // One key per license: a key enrolled with another license is replaced, never re-enrolled.
  async keyFor(state) {
    const stored = this.matching(state)
    if (stored) {
      this.instance = stored
      return
    }
    this.instance = { seed: hex(random(32)), enrollPublicKey: hex(enrollKeyPair(b4a.from(state.licenseKey, 'hex')).publicKey), counter: 0, enrolled: false }
    await this.persist()
  }

  persist() {
    const snapshot = { ...this.instance }
    this.writes = this.writes.catch(() => {}).then(() => writeInstanceKey(this.storage, snapshot))
    return this.writes
  }

  schedule(delayMs) {
    this.timers.clear(this.timer)
    this.timer = this.timers.setTimeout(() => {
      this.timer = null
      this.sending = this.sending.then(() => this.tick()).catch((err) => this.log.warn('report failed:', err.message))
    }, delayMs)
  }

  async tick() {
    const state = this.getState()
    if (this.stopped || !state || !this.instance) return
    let outcome
    try {
      outcome = await this.send(state, 'managed', REQUEST_TIMEOUT_MS)
    } catch (err) {
      outcome = { kind: 'retry', detail: err.message }
    }
    if (this.stopped) return
    if (outcome.kind === 'revoked') {
      this.revoked = true
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
    this.schedule(REPORT_EVERY_MS)
  }

  // A wrong clock is corrected from the Console's time and tried once more; a key the Console does
  // not know enrolls again.
  async send(state, reportState, timeoutMs) {
    let enroll = !this.instance.enrolled
    let skewRetried = false
    for (;;) {
      const res = await this.post(state, reportState, enroll, timeoutMs)
      if (res.status === 200) {
        if (enroll && this.instance) {
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

  // Every request carries a counter above any this install sent before, stored before it goes out:
  // an equal or lower one can only come from a second computer holding a copy of this key.
  async post(state, reportState, enroll, timeoutMs) {
    if (!this.instance) return { status: 0, error: 'no instance key' }
    this.instance = { ...this.instance, counter: this.instance.counter + 1 }
    await this.persist()
    const keyPair = instanceKeyPair(b4a.from(this.instance.seed, 'hex'))
    const timestamp = Math.floor(Date.now() / 1000) + this.offsetSeconds
    const nonce = random(NONCE_BYTES)
    const report = reportBody({ ...this.facts(state), state: reportState, reportCounter: this.instance.counter })
    const call = enroll ? CALL.ENROLL : CALL.REPORT
    const payload = enroll
      ? enrollBody({ enrollKeys: enrollKeyPair(b4a.from(state.licenseKey, 'hex')), instanceKey: keyPair.publicKey, timestamp, nonce, report })
      : report
    const body = b4a.from(JSON.stringify(payload))
    const headers = signedHeaders({ call, keyPair, timestamp, nonce, body })
    return postUpward({ apiUrl: effectiveApiUrl(state), call, headers, body, timers: this.timers, timeoutMs })
  }
}
