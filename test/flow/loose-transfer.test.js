import test from 'brittle'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpaceWithApproval, waitForCatalogEntry } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'
import { tmpPath } from '../helpers/tmp.js'

const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
// Production model: identity-at-rest + membership approval. Loose peer visibility
// rides the approval handout; overlay/in-place ship on.
const v2flags = () => ({ identityKEK: kekHex() })

function writeTmpFile(bytes) {
  const p = tmpPath('mirall-src') + '.bin'
  fs.writeFileSync(p, bytes)
  return p
}

test('A shares a file, B sees and downloads it; bytes match end-to-end', { timeout: scaled(120000) }, async (t) => {
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
  await B.request('files:download', { spaceId, path: entry.path, ownerKey: entry.owner.publicKey })
  const completed = await done

  t.ok(!completed.localPath.endsWith('.mirall.part'), 'atomic-renamed to final path')
  const downloaded = fs.readFileSync(completed.localPath)
  t.ok(downloaded.equals(bytes), 'downloaded bytes match source exactly')

  // status flips to downloaded
  const list2 = await B.files(spaceId)
  t.is(list2.find((f) => f.path === '/photo.bin').status, 'downloaded')
})

// Large enough for several read blocks, so on a platform with the hash threads on, the worker a
// release runs prepares this file on them.
test('a file of several read blocks is shared and downloaded byte-exact', { timeout: scaled(180000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const spaceId = await connectInSpaceWithApproval(t, A, B)

  const bytes = patternedBytes(40 * 1024 * 1024 + 4097, 11)
  const src = writeTmpFile(bytes)
  t.teardown(() => { try { fs.rmSync(src) } catch {} })
  await A.request('files:add', { spaceId, filePath: src, fileName: 'large.bin', fileSize: bytes.length })

  const isReady = (f) => f.path === '/large.bin' && f.status === 'remote'
  const entry = (await B.untilFiles(spaceId, (list) => list.some(isReady), { ms: 60000 })).find(isReady)
  const done = B.waitFor('event:transfer-complete', (m) => m.path === '/large.bin')
  await B.request('files:download', { spaceId, path: entry.path, ownerKey: entry.owner.publicKey })
  const completed = await done

  t.ok(fs.readFileSync(completed.localPath).equals(bytes), 'downloaded bytes match the source')
  t.absent(A.readStderr().includes('hash threads unavailable'), 'the owner prepared the file without falling back')
})
