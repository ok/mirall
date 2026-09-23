// Compiled by `npm run typecheck` through tsconfig.worker.json, never run. Each @ts-expect-error
// line asserts that a handler disagreeing with its contract row fails to compile; a loosened
// `handle` signature turns the directive itself into an error.
import type { WorkerIpc } from '../../../src/shared/core/ipc.js'
import type { RequestArgs } from '../../../src/shared/contract/request-args.js'
import type { SpaceRecord } from '../../../src/shared/contract/responses.js'

declare const ipc: WorkerIpc
declare const space: SpaceRecord

ipc.handle('files:remove', async () => ({ ok: true }))
// @ts-expect-error an acknowledgement is { ok: true }, never false
ipc.handle('files:remove', async () => ({ ok: false }))
// @ts-expect-error an acknowledgement is an object, not a word
ipc.handle('files:remove', async () => 'ok')
// @ts-expect-error a handler that answers nothing breaks a row that promises something
ipc.handle('files:remove', async () => {})

ipc.handle('spaces:list', async () => [])
// @ts-expect-error spaces:list resolves with a list, not one space
ipc.handle('spaces:list', async () => space)

ipc.handle('profile:get', async () => null)
// @ts-expect-error profile:set answers with the profile it wrote, so it is not nullable
ipc.handle('profile:set', async () => null)

// @ts-expect-error a request the contract does not declare
ipc.handle('spces:list', async () => [])

ipc.handle('space:members', async (msg) => { void msg.spaceId; return [] })
// @ts-expect-error a field the row does not declare
ipc.handle('space:members', async (msg) => { void msg.nope; return [] })

ipc.handle('space:create', async (msg) => { void msg.icon?.length; return space })
// @ts-expect-error an optional arg may be absent or null
ipc.handle('space:create', async (msg) => { void msg.icon.length; return space })

declare const members: RequestArgs<'space:members'>
const spaceId: string = members.spaceId
// @ts-expect-error a required spaceId is a string
const spaceIdNumber: number = members.spaceId

ipc.handle('ping', async (_msg, ctx) => { void ctx.client.id; return { pong: true, timestamp: 0 } })
// @ts-expect-error the context carries the client, not its id
ipc.handle('ping', async (_msg, ctx) => { const id: number = ctx.client; void id; return { pong: true, timestamp: 0 } })

void [spaceId, spaceIdNumber]
