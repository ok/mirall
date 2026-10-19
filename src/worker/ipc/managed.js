// @ts-check
// The organization-configuration surface. Registered on every install; nothing here runs until it
// is called, and an install without a license only ever gets the cheap answer.

/** @import { WorkerIpc } from '../../shared/core/ipc.js' */
/** @import { ManagedView, ManagedPreview } from '../../shared/contract/responses.js' */

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
  ipc.handle('managed:accept', async (msg) => await service.accept(msg.code))
  ipc.handle('managed:leave', async () => await service.leave())
}
