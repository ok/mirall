// The support bundle. health and the boot root are injected: the root is REASSIGNED during boot
// (the partial-root handoff), so this reads it through a getter rather than capturing it.

import os from 'bare-os'
import { getRuntimeConfig, getUpgradeKey, getRelayConfig } from '../../shared/core/runtime-config.js'
import { getRequestFailureCounters, getRequestMetrics } from '../../shared/core/ipc.js'
import { buildDiagnostics, verdictHistoryFromAudit, VERDICT_KINDS } from '../../shared/network/support-bundle.js'
import { queryAudit } from '../../shared/audit/audit-query.js'
import { deriveChannel } from '../../shared/telemetry/channel.js'
import { getInstallId } from '../../shared/telemetry/install-id.js'
import { listRecentSweeps } from '../../shared/storage/sweep-journal.js'
import {
  getSwarmStatus,
  getVerdictHistory,
  getDiagnosticCounters,
  getPeerSamples,
} from '../../shared/network/network-status.js'

const DIAGNOSTIC_HISTORY_LIMIT = 50

// Durable rows + this session's ring, MERGED: the ring dies with the process (a bundle collected
// after a restart needs the rows), and the rows are hold-down-deduped (a bundle collected during a
// live problem needs the ring's sub-60 s flaps and settling states).
async function durableVerdictHistory() {
  const ring = getVerdictHistory()
  try {
    const { entries } = await queryAudit({ kinds: VERDICT_KINDS, limit: DIAGNOSTIC_HISTORY_LIMIT })
    const durable = verdictHistoryFromAudit(entries)
    if (!durable.length) return ring
    const newest = durable[durable.length - 1].at
    return [...durable, ...ring.filter((entry) => entry.at > newest)]
  } catch {
    return ring
  }
}

export function registerDiagnostics(ipc, { health, getRoot }) {
  ipc.handle('diagnostics:export', async (msg) => {
    const cfg = getRuntimeConfig()
    const root = getRoot()
    return buildDiagnostics({
      status: getSwarmStatus(),
      history: await durableVerdictHistory(),
      env: {
        appVersion: cfg.appVersion || (cfg.dev ? 'dev' : 'unknown'),
        channel: deriveChannel(cfg),
        installId: cfg.storage ? await getInstallId(cfg.storage) : null,
        packaged: !!getUpgradeKey(),
        platform: os.platform(),
        release: os.release(),
        arch: os.arch(),
      },
      counters: getDiagnosticCounters(),
      sweeps: await listRecentSweeps(10),
      requestFailures: getRequestFailureCounters(),
      requestMetrics: getRequestMetrics(),
      health: health.snapshot({
        queueDepth: ipc.queueDepth(),
        subsystems: root?.health() || [],
        supervision: root?.supervision() || null,
        inFlightRequests: ipc.inFlightCount(),
      }),
      peerSamples: getPeerSamples(),
      relayConfig: getRelayConfig(),
    }, msg?.redact !== false)
  })
}
