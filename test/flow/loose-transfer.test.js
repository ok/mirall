import test from 'brittle'
import os from 'os'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpaceWithApproval, waitForCatalogEntry } from '../helpers/peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'

const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
// Production model: identity-at-rest + membership approval. Loose peer visibility
// rides the approval handout; overlay/in-place ship on.
const v2flags = () => ({ overlayEnabled: true, inPlaceFilesEnabled: true, membershipApprovalEnabled: true, identityKEK: kekHex() })

function writeTmpFile (bytes) {
  const p = path.join(os.tmpdir(), `mirall-src-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.bin`)
  fs.writeFileSync(p, bytes)
  return p
}

test('A shares a file, B sees and downloads it; bytes match end-to-end', { timeout: 120000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const spaceId = await connectInSpaceWithApproval(t, A, B)

  const bytes = Buffer.alloc(48 * 1024)
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) & 0xff
  const src = writeTmpFile(bytes)
  t.teardown(() => { try { fs.rmSync(src) } catch {} })

  // A publishes the file
  await A.request('files:add', { spaceId, filePath: src, fileName: 'photo.bin', fileSize: bytes.length })

  // B sees it as a remote file owned by A
  const entry = await waitForCatalogEntry(B, spaceId, '/photo.bin')
  t.ok(entry, 'B sees the file')
  t.is(entry.status, 'remote', 'status is remote (owner online, not yet downloaded)')

  // B downloads it
  const done = B.waitFor('event:transfer-complete', (m) => m.path === '/photo.bin')
  await B.request('files:download', { spaceId, path: entry.path, inPlace: true, ownerKey: entry.owner.publicKey })
  const completed = await done

  t.ok(!completed.localPath.endsWith('.partial'), 'atomic-renamed to final path')
  const downloaded = fs.readFileSync(completed.localPath)
  t.ok(downloaded.equals(bytes), 'downloaded bytes match source exactly')

  // status flips to downloaded
  const list2 = await B.request('files:list', { spaceId })
  t.is(list2.find((f) => f.path === '/photo.bin').status, 'downloaded')
})
