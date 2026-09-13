// The audit-log query surface. Every write path records through shared/audit/audit-log.js
// directly; this module only reads, configures and purges, so it needs nothing from the entry.

import {
  queryAudit,
  auditSpaces,
  auditActors,
  auditStats,
  getAuditConfig,
  setAuditConfig,
  purgeAudit,
  exportAudit,
} from '../../shared/audit/audit-log.js'

export function registerAudit(ipc) {
  ipc.handle('audit:list', async (msg) => await queryAudit(msg))
  ipc.handle('audit:spaces', async () => await auditSpaces())
  ipc.handle('audit:actors', async () => await auditActors())
  ipc.handle('audit:stats', async () => await auditStats())
  ipc.handle('audit:get-config', async () => getAuditConfig())

  // Retention and purge both change what every open Activity Log is showing, so each one pokes
  // the renderer rather than waiting for its next poll.
  ipc.handle('audit:configure', async (msg) => {
    const next = await setAuditConfig(msg)
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
    entries: await exportAudit(msg || {}),
  }))
}
