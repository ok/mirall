// @ts-check
// The support bundle. health and the boot root are injected: the root is REASSIGNED during boot
// (the partial-root handoff), so this reads it through a getter rather than capturing it.

/** @import { WorkerIpc } from '../../shared/core/ipc.js' */
/** @import { WorkerRoot } from '../boot.js' */
/** @import { HealthMonitor } from '../../shared/core/health.js' */
import os from 'bare-os'
import { getRuntimeConfig, getUpgradeKey, getRelayConfig, getAppVersionLabel, getStoragePath } from '../../shared/core/runtime-config.js'
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

/**
 * @param {WorkerIpc} ipc
 * @param {{ health: HealthMonitor, getRoot: () => WorkerRoot | null }} deps
 */
export function registerDiagnostics(ipc, { health, getRoot }) {
  ipc.handle('diagnostics:export', async (msg) => {
    const storage = getStoragePath()
    const root = getRoot()
    return buildDiagnostics({
      status: getSwarmStatus(),
      history: await durableVerdictHistory(),
      env: {
        appVersion: getAppVersionLabel(),
        channel: deriveChannel(getRuntimeConfig()),
        installId: storage ? await getInstallId(storage) : null,
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
        // Ages, oldest first: the count above says how much is in flight, this says whether any of
        // it is stuck — the one question requestMetrics cannot answer, because it records a
        // duration only on settle. Capped because a human reads this and a wedge is the first row.
        inFlightAges: ipc.inFlightAges().slice(0, 20),
      }),
      peerSamples: getPeerSamples(),
      relayConfig: getRelayConfig(),
    }, msg?.redact !== false)
  })
}
