import test from 'brittle'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer } from '../helpers/peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

// A member who leaves and rejoins in the same app session sees the others' folders and files again
// without a restart. The leave purges the departed members' profile and catalog cores; anything this
// process still held open on them must be released first, or the rejoined member reads a core whose
// storage is gone.

const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const v2flags = () => ({ identityKEK: kekHex() })

const isMember = (key) => (l, spaceId) => {
  const s = l.find((x) => x.spaceId === spaceId)
  return !!(s && s.members.some((m) => m.publicKey === key && m.status !== 'pending'))
}

async function admit(A, B, spaceId, invite, bKey) {
  const aGotB = A.waitFor('event:member-join-request', (m) => m.spaceId === spaceId && m.publicKey === bKey, 120000)
  const bGranted = B.waitFor('event:membership-granted', (m) => m.spaceId === spaceId, 120000)
  await B.request('space:join', { inviteCode: invite })
  await aGotB
  await A.request('space:approve-member', { spaceId, publicKey: bKey })
  await bGranted
  await A.until('spaces:list', {}, (l) => isMember(bKey)(l, spaceId), { ms: 60000, every: 1000 })
}

async function addLooseFile(t, peer, spaceId, name) {
  const dir = mkTmpDir(t)
  fs.writeFileSync(path.join(dir, name), name)
  await peer.request('files:add', { spaceId, filePath: path.join(dir, name), fileName: name, fileSize: name.length })
}

const looseFrom = (key, name) => (files) => files.some((e) => e.path === '/' + name && e.owner?.publicKey === key)

test('REGRESSION (FIX-REJOIN-4: after a leave and rejoin in one session, the other members\' folders stayed missing until a restart)', { timeout: scaled(300000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const aKey = (await A.request('profile:get')).personKey
  const bKey = (await B.request('profile:get')).personKey
  const { spaceId } = await A.request('space:create', { name: 'Vault' })
  const invite = await A.request('space:invite', { spaceId })
  await admit(A, B, spaceId, invite, bKey)

  const share = await A.request('share:create', { spaceId, name: 'Photos' })
  const folder = mkTmpDir(t)
  fs.writeFileSync(path.join(folder, 'note.txt'), 'shared')
  const scanned = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id, 60000)
  await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
  await scanned
  await addLooseFile(t, A, spaceId, 'before.txt')

  const hasShare = (l) => l.some((s) => s.id === share.id)
  await B.until('share:list', { spaceId }, hasShare, { ms: 60000 })
  await B.untilFiles(spaceId, looseFrom(aKey, 'before.txt'), { ms: 60000 })

  await B.request('space:leave', { spaceId })
  await A.until('spaces:list', {}, (l) => !isMember(bKey)(l, spaceId), { ms: 120000 })
  await admit(A, B, spaceId, invite, bKey)
  await B.until('spaces:list', {}, (l) => l.some((x) => x.spaceId === spaceId && x.status !== 'pending'), { ms: 60000, every: 1000 })

  t.ok(await B.until('share:list', { spaceId }, hasShare, { ms: 60000 }), 'B lists A’s folder again without a restart')
  t.ok(await B.untilFiles(spaceId, looseFrom(aKey, 'before.txt'), { ms: 60000 }), 'and A’s loose file')

  await addLooseFile(t, A, spaceId, 'after.txt')
  t.ok(await B.untilFiles(spaceId, looseFrom(aKey, 'after.txt'), { ms: 60000 }), 'and a loose file A adds after the rejoin')
})
