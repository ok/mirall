// @ts-check
// The identity's key, handed over by a client of a worker that waits for it or is locked by one that
// could not open the identity (key-wait.js). Only the host may hand it over. Neither the key nor the relay seed is logged, echoed
// or put in an error: the router logs a failure's message and fields, so every refusal here is a
// fixed sentence.

/** @import { WorkerIpc } from '../../shared/core/ipc.js' */
/** @import { HandedKey } from '../key-wait.js' */
import { requireHost } from '../../shared/core/client-trust.js'
import { isKeyHex } from '../../shared/core/unlock-provider.js'
import { AppError } from '../../shared/core/errors.js'
import { CODES } from '../../shared/contract/errors.js'

/** @param {WorkerIpc} ipc @param {{ unlock: (key: HandedKey) => Promise<void> }} deps */
export function registerIdentityUnlock(ipc, { unlock }) {
  ipc.handle('identity:unlock', async ({ kek, relaySeed }, ctx) => {
    requireHost(ctx.client, 'only the host may unlock the identity')
    if (!isKeyHex(kek)) throw new AppError(CODES.INVALID_ARGUMENT, 'kek must be 64 lowercase hex characters')
    if (relaySeed != null && !isKeyHex(relaySeed)) throw new AppError(CODES.INVALID_ARGUMENT, 'relaySeed must be 64 lowercase hex characters')
    await unlock({ kek, relaySeed: relaySeed ?? null })
    return { ok: true }
  })
}
