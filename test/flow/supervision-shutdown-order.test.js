import test from 'brittle'
import path from 'path'
import crypto from 'crypto'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpaceWithApproval } from '../helpers/peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'
import { scaled, unscaled } from '../helpers/timing.js'

const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const v2flags = () => ({ overlayEnabled: true, inPlaceFilesEnabled: true, identityKEK: kekHex() })

// The supervisor is a new subsystem in the composition root, started after every subsystem it
// supervises so the lifecycle's reverse close order stops it first. Adding a subsystem to boot.js
// reorders teardown, and a dependency expressed as a silent fallthrough degrades rather than breaks
// — the class that has passed unit and integration green through ordering regressions before. Only
// a real quit against a real peer shows it.
//
// The recovery path itself is not driven here: a stalled pass needs an in-process hung fetch or a
// connected-then-silent peer, and no IPC request, config knob or peer action produces one, because
// the production code is written not to hang. Both recoveries are red-first one layer down.
test('the supervisor rides the boot order without changing the departure conveyance',
  { timeout: scaled(180000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), flags: v2flags() })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
    const spaceId = await connectInSpaceWithApproval(t, A, B)
    const aKey = (await A.request('profile:get')).publicKey

    // The supervisor reached the real worker, not just the unit harness: its counters are in the
    // diagnostics bundle, which is also the only place a user-reported stall would ever show.
    const diag = await A.request('diagnostics:export')
    t.ok(diag.health, 'the health block is present')
    t.ok(diag.health.supervision, 'and carries the supervision counters')
    t.alike(Object.keys(diag.health.supervision).sort(), ['gaveUp', 'recoveries', 'unhealthy'],
      'counts by subsystem, with no unit key to carry a space or share id')
    t.absent(JSON.stringify(diag.health.supervision).includes(spaceId),
      'the shareable bundle names no space')

    // The departure datagram must still leave UDX before any socket drops — the first three steps
    // of boot.close(), which now run behind supervisor.pause().
    await A.request('shutdown').catch(() => {})
    // Under the un-scaled presence TTL, so a broken announce cannot pass as plain lease expiry.
    await B.until('members:online', { spaceId }, (o) => !o.includes(aKey), { ms: unscaled(12000) })
    t.pass('the peer saw the departure promptly, so the shutdown order is intact')
  })
