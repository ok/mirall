// The organization configuration of this install. Started on every boot and inert until a license
// is accepted: without managed.enc it holds no store, swarm, request or timer. Once licensed it
// keeps the overlay current from the organization's drive, and over HTTPS while no drive peer is
// connected, and owns both sources so Connect and Leave never start or stop a subsystem.
import b4a from 'b4a'
import { Subsystem } from '../../shared/core/subsystem.js'
import { AppError } from '../../shared/core/errors.js'
import { CODES } from '../../shared/contract/errors.js'
import { Scope } from '../../shared/contract/scope.js'
import { getManagedVaultKey } from '../../shared/core/store.js'
import { getAppVersionLabel, getManagedLevers, getReleaseChannel, getRuntimeConfig } from '../../shared/core/runtime-config.js'
import { getManagedOverlay, resetManagedOverlay, setManagedOverlay } from '../../shared/core/managed-overlay.js'
import { lockedKeys } from '../../shared/core/managed-effective.js'
import { record } from '../../shared/audit/audit-log.js'
import { managedChangedRow, managedJoinedRow, managedLeftRow } from '../../shared/audit/managed-change.js'
import { decodeActivationCode } from '../../shared/managed/activation-link.js'
import { bundleKeyPair, keyHint } from '../../shared/managed/derive.js'
import { CATALOG_VERSIONS, KNOWN_EXTENSIONS, KNOWN_SETTINGS } from '../../shared/managed/catalog.js'
import { selectApplied } from '../../shared/managed/select.js'
import { pinnedKeysFor } from '../../shared/managed/trust.js'
import { fetchBundles } from '../../shared/managed/https-source.js'
import { DriveSource } from '../../shared/managed/drive-source.js'
import {
  effectiveApiUrl, managedStateExists, managedStoreDir, readManagedState, removeManagedState, removeManagedStore, writeManagedState,
} from '../../shared/managed/managed-state.js'
import { followRelayConfig } from '../../shared/network/relay-follow.js'
import { computerName, devicePlatform, osRelease, resolveBackupFolder } from './device-facts.js'
import { InstanceReporter } from './instance-reporter.js'

const PREVIEW_RETRY_MS = 5000
const PREVIEW_CACHE_MS = 10 * 60_000
const REREAD_DEBOUNCE_MS = 500
const REFRESH_TIMEOUT_MS = 15_000

const hex = (buf) => b4a.toString(buf, 'hex')
const linkOf = (state) => ({ licenseKey: b4a.from(state.licenseKey, 'hex'), driveKey: b4a.from(state.driveKey, 'hex') })
const sameSettings = (a, b) => a.issuedAt === b.issuedAt && a.profileVersionId === b.profileVersionId && JSON.stringify(a.settings) === JSON.stringify(b.settings)
const sameKeys = (a, b) => JSON.stringify(a.refusedKeys) === JSON.stringify(b.refusedKeys) && JSON.stringify(a.ignoredUnlocked) === JSON.stringify(b.ignoredUnlocked)
// Spread over ±10%, so a fleet that went offline together does not ask again in step.
const jitter = (ms) => Math.round(ms * (0.9 + Math.random() * 0.2))

export class ManagedConfig extends Subsystem {
  constructor(name, deps) {
    super(name, deps)
    this.require('ipc', 'storage', 'applyRelayConfig')
    this.state = null
    this.drive = null
    this.etag = null
    this.httpsTimer = null
    this.rereadTimer = null
    this.previewCache = null
    this.lastFailure = null
    this.lastRefusal = null
    this.failures = 0
    this.generation = 0
    this.queue = Promise.resolve()
    this.reporter = new InstanceReporter({
      storage: deps.storage,
      timers: this.timers,
      log: this.log,
      getState: () => this.state,
      facts: (state) => this.reportFacts(state),
      onRevoked: () => this.deps.ipc.emit('event:reconcile', { scope: Scope.managed() }),
    })
  }

  async _open() {
    const { storage } = this.deps
    const unmanaged = () => removeManagedStore(storage).catch((err) => this.log.warn('leftover config drive store not removed:', err.message))
    if (!managedStateExists(storage)) {
      await unmanaged()
      return
    }
    const key = getManagedVaultKey()
    const state = key ? await readManagedState(storage, key, this.log) : null
    if (!state) {
      await unmanaged()
      return
    }
    this.state = state
    if (state.applied) this.publish(state.applied, { at: 'boot' })
    await this.activate({ fresh: false })
    // Boot opens the backup after this subsystem; the start report waits for it.
    await this.startReporting(getManagedLevers().reportDelayMs)
  }

  async _close() {
    await this.deactivate()
    resetManagedOverlay()
  }

  health() {
    return { ok: !this.closed && !this.stopping, detail: { state: this.state ? 'managed' : 'unmanaged', lastFailure: this.lastFailure, lastRefusal: this.lastRefusal } }
  }

  view() {
    const applied = this.state?.applied
    if (!applied) return null
    return {
      organization: applied.organization,
      locked: lockedKeys(getManagedOverlay()),
      updatedAt: applied.receivedAt,
      backupFolder: getManagedOverlay()?.backup?.folder ?? null,
      values: { relayMode: applied.settings['network.relayMode'] ?? null, retentionDays: applied.settings['audit.retentionDays'] ?? null },
      revoked: this.reporter.revoked,
    }
  }

  async preview(code) {
    const link = decodeActivationCode(code, { allowHttp: getManagedLevers().allowHttp })
    if (!link) return { kind: 'invalid' }
    const result = await this.fetchPreview(link)
    if (result.kind !== 'ready') return result
    this.previewCache = { code, at: Date.now(), link, applied: result.applied }
    const current = this.state
    const alreadyConnected = !!current && current.driveKey === hex(link.driveKey) && current.licenseKey === hex(link.licenseKey)
    return {
      kind: 'ready',
      organization: result.applied.organization,
      alreadyConnected,
      replaces: current && !alreadyConnected ? current.applied?.organization.name ?? null : null,
    }
  }

  // The link of the organization already connected changes nothing. Any other is written first:
  // a write that fails leaves the previous organization applied and its sources running again, and
  // only once the new one is on disk does the previous one hear that this computer left.
  async accept(code) {
    const ready = await this.readyFor(code)
    const key = getManagedVaultKey()
    if (!key) throw new AppError(CODES.MANAGED_UNAVAILABLE, 'managed:accept: identity locked')
    const { link } = ready
    const previous = this.state
    const sameLicense = previous?.licenseKey === hex(link.licenseKey)
    const sameDrive = previous?.driveKey === hex(link.driveKey)
    if (sameLicense && sameDrive) return this.view()
    await this.deactivate()
    const now = Date.now()
    const applied = { ...ready.applied, receivedAt: now, via: 'https' }
    const state = {
      licenseKey: hex(link.licenseKey),
      driveKey: hex(link.driveKey),
      apiUrl: link.apiUrl,
      acceptedAt: now,
      lastIssuedAt: applied.issuedAt,
      applied,
    }
    try {
      await writeManagedState(this.deps.storage, key, state)
    } catch (err) {
      await this.activate({ fresh: false })
      await this.startReporting(0)
      throw err
    }
    if (previous && !sameLicense) await this.retireInstance(previous)
    if (previous && !sameDrive) await removeManagedStore(this.deps.storage).catch((err) => this.log.warn('previous config drive store not removed:', err.message))
    if (previous?.applied && !sameDrive) {
      const left = managedLeftRow(previous.applied.organization)
      record(left.kind, left.row)
    }
    this.state = state
    this.previewCache = null
    this.etag = null
    this.publish(state.applied, { at: 'join' })
    const row = managedJoinedRow(state.applied)
    record(row.kind, row.row)
    await this.activate({ fresh: true })
    await this.startReporting(0)
    return this.view()
  }

  // The organization hears first, then managed.enc goes: a removal that fails leaves the install
  // visibly managed, never one that reads as left today and is managed again after the next boot.
  // The instance key goes last, so a retried Leave still holds it.
  async leave() {
    const state = this.state
    if (!state) return { left: null }
    const organization = state.applied?.organization ?? null
    await this.deactivate()
    await this.reporter.leave(state)
    try {
      await removeManagedState(this.deps.storage)
    } catch (err) {
      await this.activate({ fresh: false })
      throw err
    }
    if (organization) {
      const row = managedLeftRow(organization)
      record(row.kind, row.row)
    }
    await this.reporter.forget().catch((err) => this.log.warn('instance key not removed:', err.message))
    await removeManagedStore(this.deps.storage).catch((err) => this.log.warn('config drive store not removed:', err.message))
    this.state = null
    this.etag = null
    resetManagedOverlay()
    this.afterOverlayChange()
    return { left: organization?.name ?? null }
  }

  async readyFor(code) {
    const cached = this.previewCache
    if (cached && cached.code === code && Date.now() - cached.at < PREVIEW_CACHE_MS) return cached
    const link = decodeActivationCode(code, { allowHttp: getManagedLevers().allowHttp })
    if (!link) throw new AppError(CODES.INVALID_ARGUMENT, 'managed:accept: not an activation code')
    const result = await this.fetchPreview(link)
    if (result.kind !== 'ready') throw new AppError(CODES.MANAGED_UNAVAILABLE, `managed:accept: ${result.kind}`)
    return { link, applied: result.applied }
  }

  // HTTPS only: an install without a license opens no store and no swarm. A served drive with
  // nothing for this key yet is asked again until the deadline, since a new key reaches the Console
  // a moment after its link.
  async fetchPreview(link) {
    const deadline = Date.now() + getManagedLevers().previewTimeoutMs
    const ctx = this.verifyContext(link, 0)
    const hint = keyHint(ctx.bundleKeyPair.publicKey)
    let outcome = 'unreachable'
    while (!this.stopping) {
      const res = await fetchBundles({ apiUrl: link.apiUrl, driveKey: link.driveKey, hint, timers: this.timers, timeoutMs: Math.max(1000, Math.min(REFRESH_TIMEOUT_MS, deadline - Date.now())) })
      if (res.kind === 'org-unavailable') return { kind: 'no-configuration' }
      if (res.kind === 'error') return { kind: 'invalid' }
      if (res.kind === 'retry' && res.detail === 'rate_limited') break
      if (res.kind === 'bundles') {
        const selected = selectApplied(res.bundles, ctx)
        if (selected.applied) return { kind: 'ready', applied: { ...selected.applied, refusedKeys: selected.refused, ignoredUnlocked: selected.ignoredUnlocked } }
        if (selected.failures.length) {
          this.log.warn('preview: no bundle verified:', selected.failures.map((f) => f.failure).join(','))
          return { kind: 'invalid' }
        }
        outcome = 'no-configuration'
      }
      if (Date.now() + PREVIEW_RETRY_MS > deadline) break
      await this.sleep(PREVIEW_RETRY_MS)
    }
    return { kind: outcome }
  }

  verifyContext(link, lastIssuedAt) {
    const levers = getManagedLevers()
    return {
      pinnedKeys: pinnedKeysFor(getReleaseChannel(), { testKeyHex: levers.testSigningKey }),
      driveKey: link.driveKey,
      lastIssuedAt,
      catalogVersions: CATALOG_VERSIONS,
      knownExtensions: KNOWN_EXTENSIONS,
      knownSettings: KNOWN_SETTINGS,
      bundleKeyPair: bundleKeyPair(link.licenseKey),
      allowHttp: levers.allowHttp,
    }
  }

  async activate({ fresh }) {
    if (!this.state || this.stopping) return
    const levers = getManagedLevers()
    if (this.deps.network) {
      const drive = new DriveSource({
        dir: managedStoreDir(this.deps.storage),
        bootstrap: getRuntimeConfig().dhtBootstrap,
        driveKey: linkOf(this.state).driveKey,
        timers: this.timers,
        onChange: () => this.scheduleReread(REREAD_DEBOUNCE_MS),
        log: this.log,
      })
      try {
        await drive.open()
        this.drive = drive
        this.scheduleReread(0)
      } catch (err) {
        this.log.warn('config drive unavailable:', err.message)
        await drive.close().catch(() => {})
      }
    }
    this.scheduleHttps(this.drive ? levers.driveGraceMs : fresh ? levers.httpsPollMs : 0)
  }

  async startReporting(delayMs) {
    if (!this.state || this.stopping || !devicePlatform()) return
    try {
      await this.reporter.start(this.state, { delayMs })
    } catch (err) {
      this.log.warn('reporting not started:', err.message)
    }
  }

  // A key belongs to one license: the organization being replaced hears that this computer left.
  async retireInstance(previous) {
    await this.reporter.leave(previous)
    await this.reporter.forget().catch((err) => this.log.warn('instance key not removed:', err.message))
  }

  reportFacts(state) {
    const applied = state.applied
    return {
      appVersion: getAppVersionLabel(),
      channel: getReleaseChannel(),
      platform: devicePlatform(),
      osVersion: osRelease(),
      hostname: computerName(),
      applied: applied ? { profileVersionId: applied.profileVersionId, issuedAt: applied.issuedAt * 1000, appliedAt: applied.receivedAt, via: applied.via } : null,
      refusedKeys: applied?.refusedKeys ?? [],
      ignoredUnlocked: applied?.ignoredUnlocked ?? [],
      backup: this.deps.getBackup?.()?.protection() ?? null,
    }
  }

  // Ends every fetch and reread in flight: one that answers after this applies nothing, so a Leave
  // or a Connect is never overwritten by what the previous organization's sources were still reading.
  async deactivate() {
    this.generation += 1
    this.reporter.stop()
    this.timers.clear(this.httpsTimer)
    this.timers.clear(this.rereadTimer)
    this.httpsTimer = null
    this.rereadTimer = null
    await this.queue.catch(() => {})
    const drive = this.drive
    this.drive = null
    if (drive) await drive.close().catch((err) => this.log.warn('config drive close failed:', err.message))
  }

  // While a drive peer is connected the drive is the source and no request is made: a fleet shares
  // one drive key, and the Console only answers for it while the drive cannot.
  scheduleHttps(delayMs) {
    this.timers.clear(this.httpsTimer)
    this.httpsTimer = this.timers.setTimeout(async () => {
      this.httpsTimer = null
      const poll = getManagedLevers().httpsPollMs
      let next = poll
      try {
        if (!this.drive || this.drive.peers === 0) {
          const res = await this.refreshHttps()
          // A rate limit is the Console's to set; any other failure is retried sooner than the poll,
          // backing off towards it while the failures last.
          if (res?.kind === 'retry' && res.detail === 'rate_limited') next = Math.max(poll, res.afterMs)
          else if (res?.kind === 'retry') next = Math.min(poll, res.afterMs * 2 ** this.failures++)
          else this.failures = 0
        }
      } catch (err) {
        this.log.warn('configuration refresh failed:', err.message)
      }
      if (this.state && !this.stopping && !this.httpsTimer) this.scheduleHttps(jitter(next))
    }, delayMs)
  }

  scheduleReread(delayMs) {
    this.timers.clear(this.rereadTimer)
    this.rereadTimer = this.timers.setTimeout(async () => {
      this.rereadTimer = null
      const drive = this.drive
      if (!drive) return
      const generation = this.generation
      try {
        const bundles = await drive.readBundles()
        if (bundles.length) await this.consider(bundles, 'drive', generation)
      } catch (err) {
        this.log.warn('config drive read failed:', err.message)
      }
    }, delayMs)
  }

  async refreshHttps() {
    const state = this.state
    if (!state) return null
    const link = linkOf(state)
    const ctx = this.verifyContext(link, state.lastIssuedAt)
    const generation = this.generation
    const res = await fetchBundles({ apiUrl: effectiveApiUrl(state), driveKey: link.driveKey, hint: keyHint(ctx.bundleKeyPair.publicKey), etag: this.etag, timers: this.timers, timeoutMs: REFRESH_TIMEOUT_MS })
    if (generation !== this.generation) return res
    if (res.kind === 'bundles') {
      // The tag advances only once the response is applied: a failed write must be fetched again,
      // not answered 304 from now on.
      await this.consider(res.bundles, 'https', generation)
      if (generation !== this.generation) return res
      this.etag = res.etag
      this.lastFailure = null
    } else if (res.kind === 'unchanged') {
      this.lastFailure = null
    } else {
      this.lastFailure = res.kind === 'org-unavailable' ? 'org-unavailable' : res.detail
    }
    return res
  }

  // A newer or different verified bundle is written to managed.enc first, then published, so a
  // crash between the two leaves the newer configuration on disk to be applied at the next boot. One
  // at a time: the drive and HTTPS may both deliver the same bundle.
  consider(candidates, via, generation) {
    return this.serial(() => this.apply(candidates, via, generation))
  }

  // A bundle that verifies nowhere is said once per answer, in the log and in health: an install that
  // silently keeps an old configuration looks fine everywhere else.
  async apply(candidates, via, generation) {
    const state = this.state
    if (!state || this.stopping || generation !== this.generation) return
    const selected = selectApplied(candidates, this.verifyContext(linkOf(state), state.lastIssuedAt))
    if (!selected.applied) {
      this.lastRefusal = selected.failures.length ? selected.failures.map((f) => f.failure).join(',') : null
      if (this.lastRefusal) this.log.warn('no configuration bundle verified:', this.lastRefusal)
      return
    }
    this.lastRefusal = null
    if (selected.refused.length) this.log.warn('configuration values refused:', selected.refused.join(','))
    const candidate = { ...selected.applied, refusedKeys: selected.refused, ignoredUnlocked: selected.ignoredUnlocked }
    const same = state.applied && sameSettings(state.applied, candidate)
    if (same && sameKeys(state.applied, candidate)) return
    const key = getManagedVaultKey()
    if (!key) return
    // The same configuration with a different verdict on its keys (this build knows more of them)
    // is not newly applied: it keeps when it arrived, and only the report changes.
    const applied = same ? { ...state.applied, refusedKeys: candidate.refusedKeys, ignoredUnlocked: candidate.ignoredUnlocked } : { ...candidate, receivedAt: Date.now(), via }
    const next = { ...state, lastIssuedAt: applied.issuedAt, applied }
    await writeManagedState(this.deps.storage, key, next)
    if (this.state !== state || generation !== this.generation) return
    this.state = next
    if (!same) this.publish(applied, { at: 'update' })
    this.reporter.changed()
  }

  backupOpened() {
    if (this.state) this.reporter.changed()
  }

  publish(applied, { at }) {
    const before = getManagedOverlay()
    setManagedOverlay({
      organization: applied.organization,
      settings: applied.settings,
      backup: resolveBackupFolder(applied.settings, this.deps.installId ?? null),
    })
    // At boot the overlay is all: boot installs the relay once both swarms are up, and the backup
    // opens after this. A join records its own row.
    if (at === 'boot') return
    if (at === 'update') {
      const row = managedChangedRow(before, applied)
      if (row) record(row.kind, row.row)
    }
    this.afterOverlayChange()
  }

  afterOverlayChange() {
    this.deps.applyRelayConfig()
    followRelayConfig().catch((err) => this.log.warn('connections not brought in line with the relay mode:', err.message))
    this.deps.getBackup?.()?.reconsider()
    this.deps.ipc.emit('event:audit-updated', {})
    this.deps.ipc.emit('event:reconcile', { scope: Scope.managed() })
    this.deps.ipc.emit('event:reconcile', { scope: Scope.settings() })
  }

  serial(task) {
    const run = this.queue.then(task, task)
    this.queue = run.catch((err) => this.log.warn('configuration refresh failed:', err.message))
    return run
  }

  sleep(ms) {
    return new Promise((resolve) => this.timers.setTimeout(resolve, ms))
  }
}
