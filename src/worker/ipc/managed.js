// @ts-check
// The organization-configuration surface. Registered on every install; nothing here runs until it
// is called, and an install without a license only ever gets the cheap answer.

/** @import { WorkerIpc } from '../../shared/core/ipc.js' */
/** @import { ManagedView, ManagedPreview } from '../../shared/contract/responses.js' */
import { requireHost } from '../../shared/core/client-trust.js'

/**
 * @typedef {{
 *   view: () => ManagedView | null,
 *   preview: (code: string) => Promise<ManagedPreview>,
 *   accept: (code: string) => Promise<ManagedView>,
 *   leave: () => Promise<{ left: string | null }>,
 * }} ManagedService
 */

/** @param {WorkerIpc} ipc @param {{ service: ManagedService }} deps */
export function registerManaged(ipc, { service }) {
  ipc.handle('managed:get', async () => service.view())
  ipc.handle('managed:preview', async (msg) => await service.preview(msg.code))
  // Who governs this install's relay, Activity Log and backup is the host's choice alone.
  ipc.handle('managed:accept', async (msg, ctx) => {
    requireHost(ctx.client, 'only the host may connect this computer to an organization')
    return await service.accept(msg.code)
  })
  ipc.handle('managed:leave', async (_msg, ctx) => {
    requireHost(ctx.client, 'only the host may leave the organization')
    return await service.leave()
  })
}
