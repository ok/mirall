import { JOIN_REQUEST_FRAME_OVERHEAD } from '../contract/limits.js'
import { buildConfig, defaultOf, ruleOf, tabledKeys } from './runtime-config-schema.js'

// The live runtime config: one built object, replaced whole by setRuntimeConfig(bootstrap) and
// patched by the live setters. getRuntimeConfig() hands back the raw overrides; the getters below
// hand back the validated read. Reach for a getter unless you specifically want what the host sent.

let config = buildConfig()

export function setRuntimeConfig(next) {
  config = buildConfig(next)
}

function patch(partial) {
  config = buildConfig({ ...config, ...partial })
}

// Validation happens here, when a getter READS, never when the config is built: the live setters
// re-ingest their own output, so buildConfig has to stay a no-op on it. A key with no rule
// resolves to its raw override, so attaching a rule later is one table row rather than an edit
// inside a getter.
function read(key) {
  const spec = ruleOf(key)
  return spec ? spec.rule(config[key], defaultOf(key), spec.min) : config[key]
}

/** @internal the ruled set is the thing a reader is most likely to "complete" by filling in a */
// blank, and every blank is a DoS bound or a user cap. runtime-config-rules.test.js pins the set.
export function _rulesForTests() {
  const ruled = {}
  for (const key of tabledKeys()) {
    const spec = ruleOf(key)
    if (spec) ruled[key] = { rule: spec.rule.name, min: spec.min }
  }
  return { ruled, defaultedKeys: tabledKeys().length }
}

export function getRuntimeConfig() {
  return config
}

export function setDownloadFolder(folder) {
  patch({ downloadFolder: folder })
}

export function setVerbose(verbose) {
  patch({ verbose })
}

export function setRelayConfig(mode, relay) {
  patch({ relayMode: mode, relay })
}

export function setBandwidthLimits({ downloadKBps, uploadKBps } = {}) {
  patch({
    downloadKBps: coerceKBps(downloadKBps, config.downloadKBps),
    uploadKBps: coerceKBps(uploadKBps, config.uploadKBps),
  })
}

// A partial update, so its fallback is the LIVE value rather than the tabled default: omitting a
// direction, or sending a corrupt one, leaves that direction's cap where the user last set it.
function coerceKBps(next, fallback) {
  if (next === undefined || next === null) return fallback
  return typeof next === 'number' && Number.isFinite(next) && next >= 0 ? next : fallback
}

export function getRelayConfig() {
  return { mode: config.relayMode, relay: config.relay }
}

export function getUpgradeKey() {
  return config.upgradeKey
}

export function getPublishOrder() {
  return config.publishOrder
}

export function isHandshakeIdentityBindingEnabled() {
  return config.handshakeIdentityBindingEnabled
}

export function isOverlayEnabled() {
  return config.overlayEnabled
}

export function isInPlaceFilesEnabled() {
  return config.inPlaceFilesEnabled
}

export function isSharePrepareProgressEnabled() {
  return config.sharePrepareProgressEnabled
}

export function isSeparateContentPlaneEnabled() {
  return config.separateContentPlane
}

export function getPeerPresenceDwellMs() {
  return read('peerPresenceDwellMs')
}

export function getDeepReconcileEvery() {
  return read('deepReconcileEvery')
}

export function getDeriveDebounceMs() {
  return read('deriveDebounceMs')
}

export function getForeignPollIntervalMs() {
  return read('foreignPollIntervalMs')
}

export function getForeignFullWalkEvery() {
  return read('foreignFullWalkEvery')
}

export function getCaptureMemberRecordMs() {
  return read('captureMemberRecordMs')
}

export function getSupervisionProbeIntervalMs() {
  return read('supervisionProbeIntervalMs')
}

export function getSupervisionRecoverBudgetMs() {
  return read('supervisionRecoverBudgetMs')
}

export function getReconcileStallWindowMs() {
  return read('reconcileStallWindowMs')
}

export function getPublishStallWindowMs() {
  return read('publishStallWindowMs')
}

export function getConvergenceStallWindowMs() {
  return read('convergenceStallWindowMs')
}

export function getPublishConcurrency() {
  return read('publishConcurrency')
}

export function getDownloadConcurrency() {
  return read('downloadConcurrency')
}

export function getPeerCatalogCacheLimit() {
  return read('peerCatalogCacheLimit')
}

export function getListFilesCap() {
  return read('listFilesCap')
}

export function getMaxFilesPerShare() {
  return read('maxFilesPerShare')
}

export function getServeChunkMapCacheBytes() {
  return read('serveChunkMapCacheBytes')
}

export function getPeerFrameMaxBytes() {
  return read('peerFrameMaxBytes')
}

// The avatar budget for an avatar that travels INLINE in a peer frame, which is a different
// question from what may be stored at rest: the receiver charges the whole frame against
// peerFrameMaxBytes before it parses it, so an avatar sized by maxAvatarBytes (4x larger) makes
// the frame carrying it disappear unread. Never returns 0 while the frame cap is on —
// sanitizeAvatar reads 0 as "no size bound", so a budget eaten entirely by the overhead clamps to
// 1 byte, which is below the shortest possible data URI and therefore admits nothing.
export function joinRequestAvatarMaxBytes() {
  const frameMax = getPeerFrameMaxBytes()
  if (frameMax === 0) return read('maxAvatarBytes')
  return Math.max(1, frameMax - JOIN_REQUEST_FRAME_OVERHEAD)
}

// KB/s on the wire, bytes/s to callers: the rule validates, the getter converts.
export function getBandwidthLimits() {
  return { download: read('downloadKBps') * 1024, upload: read('uploadKBps') * 1024 }
}

export function getNetImpair() {
  return read('netImpair')
}

export function getIdentityFrameDropWindow() {
  return { after: read('testDropIdentityFramesAfter'), count: read('testDropIdentityFramesCount') }
}

export function getConnectionCaps() {
  return {
    maxServerConnections: read('maxServerConnections'),
    maxClientConnections: read('maxClientConnections'),
    maxPendingRequesters: read('maxPendingRequesters'),
  }
}

export function getMembershipCaps() {
  return {
    maxMembersPerSpace: read('maxMembersPerSpace'),
    maxApprovalsPerMember: read('maxApprovalsPerMember'),
    maxRequestsPerMember: read('maxRequestsPerMember'),
    maxInvitesPerMember: read('maxInvitesPerMember'),
    peerBeeCaptureMaxBlocks: read('peerBeeCaptureMaxBlocks'),
    maxAvatarBytes: read('maxAvatarBytes'),
  }
}

export function getMirrorDeletionGuard() {
  return {
    minMirrorDeletions: read('minMirrorDeletions'),
    maxMirrorDeletionRatio: read('maxMirrorDeletionRatio'),
  }
}

export function getSweepPurgeGuard() {
  return {
    minSweepPurgeCores: read('minSweepPurgeCores'),
    maxSweepPurgeCores: read('maxSweepPurgeCores'),
    maxSweepPurgeRatio: read('maxSweepPurgeRatio'),
  }
}

export function getPeerFrameLimits() {
  return {
    burst: read('peerFrameBurst'),
    refillMs: read('peerFrameRefillMs'),
    abuseThreshold: read('peerFrameAbuseThreshold'),
  }
}

export function getOverlayServeLimit() {
  return {
    burst: read('overlayServeBurst'),
    refillMs: read('overlayServeRefillMs'),
    abuseThreshold: read('overlayServeAbuseThreshold'),
  }
}

export function getHandshakeRateLimit() {
  return {
    matched: {
      burst: read('handshakeBurst'),
      burstPerTopic: read('handshakeBurstPerTopic'),
      refillMs: read('handshakeRefillMs'),
      abuseThreshold: read('handshakeAbuseThreshold'),
    },
    unmatched: {
      burst: read('handshakeUnmatchedBurst'),
      refillMs: read('handshakeUnmatchedRefillMs'),
      abuseThreshold: read('handshakeUnmatchedAbuseThreshold'),
    },
  }
}

export function getConvergenceConfig() {
  return {
    convergenceTickMs: read('convergenceTickMs'),
    announceBaseMs: read('announceBaseMs'),
    announceCapMs: read('announceCapMs'),
    announceMaxAttempts: read('announceMaxAttempts'),
    dupReciprocalFloorMs: read('dupReciprocalFloorMs'),
    convergenceEscalateTicks: read('convergenceEscalateTicks'),
    convergenceRefreshMinMs: read('convergenceRefreshMinMs'),
    convergenceMaxEscalations: read('convergenceMaxEscalations'),
  }
}
