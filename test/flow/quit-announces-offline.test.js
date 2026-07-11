import test from 'brittle'
import path from 'path'
import crypto from 'crypto'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpaceWithApproval } from '../helpers/peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'
import { scaled, unscaled } from '../helpers/timing.js'

const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const v2flags = () => ({ overlayEnabled: true, inPlaceFilesEnabled: true, membershipApprovalEnabled: true, identityKEK: kekHex() })

// A graceful quit (the real {type:'shutdown'} that runs safeShutdown → broadcastDeparture) must
// drop the owner from the peer's presence promptly — well under the 15s PRESENCE_TTL_MS — instead
// of waiting out the socket close / TTL. Guards the conveyance path against regressions.
test('graceful quit announces offline: peer drops the owner from presence promptly',
  { timeout: scaled(120000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), flags: v2flags() })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), flags: v2flags() })
    const spaceId = await connectInSpaceWithApproval(t, A, B)
    const aKey = (await A.request('profile:get')).publicKey
    t.ok((await B.request('members:online', { spaceId })).includes(aKey), 'owner online before quit')

    await A.request('shutdown').catch(() => {})   // safeShutdown → broadcastDeparture → teardown
    // Bound stays under the un-scaled 15s PRESENCE_TTL_MS (which is NOT time-scaled) so this
    // remains a real promptness check, not a pass-via-lease-expiry, even on slow/scaled CI.
    await B.until('members:online', { spaceId }, (o) => !o.includes(aKey), { ms: unscaled(12000) })
    t.absent((await B.request('members:online', { spaceId })).includes(aKey),
      'owner offline promptly after graceful quit, well under the 15s TTL')
  })
