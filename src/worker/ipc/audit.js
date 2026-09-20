// The audit-log query surface. Every write path records through shared/audit/audit-log.js
// directly; this module only reads, configures and purges, so it needs nothing from the entry.

import { getAuditConfig, setAuditConfig } from '../../shared/audit/audit-log.js'
import { queryAudit, auditSpaces, auditActors, auditStats, exportAudit } from '../../shared/audit/audit-query.js'
import { purgeAudit } from '../../shared/audit/audit-reclaim.js'

export function registerAudit(ipc) {
  // Projected, not forwarded. Passing `msg` carried the frame envelope — id and type — into a query
  // builder alongside the filters, and made the contract's args the only description of a surface
  // nothing enforced.
  ipc.handle('audit:list', async (msg) => await queryAudit({
    spaceId: msg.spaceId, cursor: msg.cursor, limit: msg.limit,
    kinds: msg.kinds, categories: msg.categories, actorKey: msg.actorKey,
    search: msg.search, since: msg.since, until: msg.until,
  }))
  ipc.handle('audit:spaces', async () => await auditSpaces())
  ipc.handle('audit:actors', async () => await auditActors())
  ipc.handle('audit:stats', async () => await auditStats())
  ipc.handle('audit:get-config', async () => getAuditConfig())

  // Retention and purge both change what every open Activity Log is showing, so each one pokes
  // the renderer rather than waiting for its next poll.
  ipc.handle('audit:configure', async (msg) => {
    const next = await setAuditConfig({
      enabled: msg.enabled, retentionDays: msg.retentionDays, maxEntries: msg.maxEntries,
    })
    ipc.emit('event:audit-updated', {})
    return next
  })
  ipc.handle('audit:purge', async () => {
    const result = await purgeAudit()
    ipc.emit('event:audit-updated', {})
    return result
  })

  ipc.handle('audit:export', async (msg) => ({
    version: 1,
    exportedAt: Date.now(),
    entries: await exportAudit({ spaceId: msg?.spaceId, since: msg?.since, until: msg?.until }),
  }))
}
