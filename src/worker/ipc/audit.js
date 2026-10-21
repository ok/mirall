// @ts-check
// The audit-log query surface. Every write path records through shared/audit/audit-log.js
// directly; this module only reads, configures and purges, so it needs nothing from the entry.

/** @import { WorkerIpc } from '../../shared/core/ipc.js' */
/** @import { AuditConfig } from '../../shared/contract/responses.js' */
import { getAuditConfig, setAuditConfig } from '../../shared/audit/audit-log.js'
import { queryAudit, auditSpaces, auditActors, auditStats, exportAudit } from '../../shared/audit/audit-query.js'
import { purgeAudit } from '../../shared/audit/audit-reclaim.js'
import { assertRecordKept, assertUnlocked, recordKept } from '../../shared/core/managed-overlay.js'

/** @param {Omit<AuditConfig, 'deleteLocked'>} config @returns {AuditConfig} */
const configView = (config) => ({ ...config, deleteLocked: recordKept() })

/** @param {WorkerIpc} ipc */
export function registerAudit(ipc) {
  // Projected, not forwarded. Passing `msg` carried the frame envelope — id and type — into a query
  // builder alongside the filters, and made the contract's args the only description of a surface
  // nothing enforced.
  ipc.handle('audit:list', async (msg) => await queryAudit({
    spaceId: msg.spaceId, cursor: msg.cursor, limit: msg.limit,
    kinds: msg.kinds, categories: msg.categories, actorKey: msg.actorKey,
    search: msg.search, searchKinds: msg.searchKinds, since: msg.since, until: msg.until,
  }))
  ipc.handle('audit:spaces', async () => await auditSpaces())
  ipc.handle('audit:actors', async () => await auditActors())
  ipc.handle('audit:stats', async () => await auditStats())
  ipc.handle('audit:get-config', async () => configView(getAuditConfig()))

  // Retention and purge both change what every open Activity Log is showing, so each one pokes
  // the renderer rather than waiting for its next poll.
  ipc.handle('audit:configure', async (msg) => {
    const current = getAuditConfig()
    assertUnlocked('audit.enabled', msg.enabled, current.enabled, 'audit:configure')
    assertUnlocked('audit.retentionDays', msg.retentionDays, current.retentionDays, 'audit:configure')
    if (typeof msg.maxEntries === 'number' && msg.maxEntries < current.maxEntries) assertRecordKept('audit:configure')
    const next = await setAuditConfig({
      enabled: msg.enabled, retentionDays: msg.retentionDays, maxEntries: msg.maxEntries,
    })
    ipc.emit('event:audit-updated', {})
    return configView(next)
  })
  ipc.handle('audit:purge', async () => {
    assertRecordKept('audit:purge')
    const result = await purgeAudit()
    ipc.emit('event:audit-updated', {})
    return result
  })

  ipc.handle('audit:export', async (msg) => ({
    version: 2,
    exportedAt: Date.now(),
    entries: await exportAudit({ spaceId: msg?.spaceId, since: msg?.since, until: msg?.until }),
  }))
}
