import test from 'brittle'
import { freshPeer } from '../helpers/store.js'
import { createFakeIpc } from '../helpers/fake-ipc.js'
import { registerShares } from '../../src/worker/ipc/shares.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { publishShare, generateShareId } from '../../src/shared/shares/shares.js'
import { getLocalPublicKeyHex } from '../../src/shared/spaces/profile.js'
import { advertise } from '../../src/shared/shares/own-catalog.js'

const silentLog = { debug() {}, info() {}, warn() {}, error() {} }

// A share whose contentMode this build cannot serve — a retired 'eager'/'deferred' record, an absent
// mode, or one from a newer release — resolves to UNSUPPORTED. The share handlers must degrade:
// list empty, count nothing, refuse a read. None of them may fall through to a path that no longer
// exists, crash, or hang.
for (const contentMode of ['eager', 'future-mode', undefined]) {
  test(`a share with contentMode ${contentMode ?? '(absent)'} degrades, never misroutes`, async (t) => {
    await freshPeer(t)
    const { spaceId } = await createSpace('Aurora')
    const ownerKey = getLocalPublicKeyHex()
    const share = { id: generateShareId(), type: 'owned-folder', name: 'Vault', owner: ownerKey, contentMode, createdAt: Date.now() }
    await publishShare(spaceId, share)
    await advertise(spaceId, share.id, 'a.bin', { size: 4, mtime: 1, contentHash: 'ab'.repeat(32) })
    const fake = createFakeIpc()
    registerShares(fake.ipc, { log: silentLog, intents: null, mountOwnedShare: async () => {} })
    const req = { spaceId, ownerKey, shareId: share.id }

    const files = await fake.call('share:list-files', req)
    t.alike(files.entries, [], 'lists empty although its catalog holds a row')
    const info = await fake.call('share:folder-info', req)
    t.is(info.fileCount, 0, 'folder-info counts nothing')
    await t.exception(fake.call('share:read-file', { ...req, relPath: 'a.bin' }), /unsupported content mode/, 'a read is refused')
  })
}
