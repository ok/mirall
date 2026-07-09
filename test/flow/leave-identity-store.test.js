import test from 'brittle'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes } from '../helpers/fixtures.js'

const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')

// REGRESSION (FIX): in identity mode (MIR-02) the own drive is built over the ROOT
// corestore (the `_db` Hyperdrive ctor path), so purgeSpaceDrive's drive.close()
// closed the root corestore and killed every other session ("RocksDB session is
// closed" / "Cannot make sessions on a closing core"). The leave then never reached
// the catalog-record delete, so the space was stranded in the list forever and every
// subsequent worker op threw SESSION_CLOSED.
test('leaving an identity-mode space leaves the root store intact and removes the record', { timeout: 150000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, {
    bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t),
    flags: { identityKEK: kekHex() },
  })

  const keep = await A.request('space:create', { name: 'Keep' })
  const drop = await A.request('space:create', { name: 'Drop' })

  // Give the space a real owned share + file so its drive has a blobs core to purge.
  const share = await A.request('share:create', { spaceId: drop.spaceId, name: 'Docs' })
  const folder = mkTmpDir(t)
  fs.writeFileSync(path.join(folder, 'a.bin'), patternedBytes(8 * 1024, 7))
  const scan = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
  await A.request('owned-folder:mount', { spaceId: drop.spaceId, shareId: share.id, mountPath: folder })
  await scan

  // Pre-fix this rejected (handler threw SESSION_CLOSED after drive.close() closed the root).
  const res = await A.request('space:leave', { spaceId: drop.spaceId })
  t.ok(res?.ok, 'leave resolves — root store was not closed')

  // The root store must still be alive: pre-fix every one of these threw SESSION_CLOSED.
  const spaces = await A.request('spaces:list')
  t.absent(spaces.some((s) => s.spaceId === drop.spaceId), 'left space record is gone')
  t.ok(spaces.some((s) => s.spaceId === keep.spaceId), 'the other space survives — root store intact')

  const more = await A.request('space:create', { name: 'After' })
  t.ok(more?.spaceId, 'store still writable after leave')
})
