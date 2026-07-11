import test from 'brittle'
import { localTestnet } from '../helpers/testnet.js'
import fs from 'fs'
import path from 'path'
import { launchPeer, connectInSpace, waitForCatalogEntry } from '../helpers/peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

const FLAGS = { overlayEnabled: true }
const scopeIs = (kind, spaceId) => (m) => !!m.scope && m.scope.kind === kind && (spaceId == null || m.scope.spaceId === spaceId)

// REGRESSION (FIX-EDA-18: handshake/presence member transitions emitted event:members-updated but
// no Scope.members reconcile hint (coverage-audit P7) — a members view on the reconcile channel
// would never re-derive on a join, a leave, or a share change. POKE_SCOPE must fan the whole
// membership/shares event family into coalesced reconcile hints on the wire.)
test('REGRESSION (FIX-EDA-18): member and share transitions fan reconcile hints',
  { timeout: scaled(180000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: mkTmpDir(t), flags: FLAGS })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', downloads: mkTmpDir(t), flags: FLAGS })

    // Arm before the join: the arrival hint fires during connect, when the spaceId is not yet known.
    const sawJoinHint = A.waitFor('event:reconcile', scopeIs('members'), 60000)
    const spaceId = await connectInSpace(t, A, B)
    await sawJoinHint
    t.pass('handshake arrival fanned a members-scoped reconcile hint')

    const sawShares = B.waitFor('event:reconcile', scopeIs('shares', spaceId), 60000)
    await A.request('share:create', { spaceId, name: 'Vault', contentMode: 'overlay' })
    await sawShares
    t.pass('share creation fanned a shares-scoped reconcile hint')

    const sawLeave = A.waitFor('event:reconcile', scopeIs('members', spaceId), 60000)
    await B.request('space:leave', { spaceId })
    await sawLeave
    t.pass('leave fanned a members-scoped reconcile hint')

    A.kill()
  })

// Companion coverage for FIX-B1 (the red-first pin is structural, in
// test/unit/handshake-post-persist-hint.test.js — the reciprocal handshake round makes a
// pure ordering assertion pass even without the fix): a joiner must end up with a files
// hint after the member persist AND actually list a loose file shared before it ever
// connected — the "Nothing shared yet" wedge scenario end-to-end.
test('a joiner gets files hints after member persist and lists a pre-connect loose file',
  { timeout: scaled(180000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const flags = { overlayEnabled: true, inPlaceFilesEnabled: true }
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: mkTmpDir(t), flags })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', downloads: mkTmpDir(t), flags })

    const space = await A.request('space:create', { name: 'Loose' })
    const spaceId = space.spaceId
    const src = path.join(mkTmpDir(t), 'note.txt')
    fs.writeFileSync(src, 'shared before Bob ever connected')
    await A.request('files:add', { spaceId, filePath: src, fileName: 'note.txt', fileSize: 32 })

    const seq = []
    B.on('event:files-updated', (m) => { if (m.spaceId === spaceId) seq.push('files') })
    B.on('event:members-updated', (m) => { if (m.spaceId === spaceId) seq.push('members') })

    const inviteCode = await A.request('space:invite', { spaceId })
    const bSawA = B.waitFor('event:member-joined', (m) => m.spaceId === spaceId)
    await B.request('space:join', { inviteCode })
    await bSawA

    const filesAfterMembers = () => {
      const m = seq.indexOf('members')
      return m !== -1 && seq.slice(m + 1).includes('files')
    }
    const deadline = Date.now() + scaled(30000)
    while (!filesAfterMembers() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
    t.ok(filesAfterMembers(), `a files hint follows the member persist (saw: ${seq.join(',')})`)

    const entry = await waitForCatalogEntry(B, spaceId, '/note.txt')
    t.ok(entry, "Bob lists Alice's pre-connect loose file")

    A.kill()
  })
