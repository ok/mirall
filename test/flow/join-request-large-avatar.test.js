import test from 'brittle'
import crypto from 'crypto'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer } from '../helpers/peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const v2flags = () => ({ identityKEK: kekHex() })

// A well-formed PNG data URI of exactly `bytes` characters. Storable (the cap at rest is 256 KiB),
// far too large to ride inside a peer frame (the cap on the wire is 64 KiB).
const HEAD = 'data:image/png;base64,'
const avatarOf = (bytes) => HEAD + 'A'.repeat(bytes - HEAD.length)

// REGRESSION (FIX-AVFRAME-4: the avatar rode inline in the membership:request frame at up to the
// 256 KiB storage cap, while the receiver charges the whole frame against a 64 KiB budget BEFORE
// parsing it. Anything in between made the join request vanish: the approver saw no banner and no
// audit row, the joiner stayed pending with no feedback, and the only evidence was a warn line on
// the approver's machine. Changing your avatar while a join was pending could move a working join
// into that state, because the profile broadcast re-sends the request.)
test('REGRESSION (FIX-AVFRAME-4): a joiner with an over-frame avatar still reaches the approver',
  { timeout: scaled(150000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })

    const space = await A.request('space:create', { name: 'Secret' })
    const bKey = (await B.request('profile:get')).publicKey
    const invite = await A.request('space:invite', { spaceId: space.spaceId })

    const big = avatarOf(200 * 1024)
    const bProfile = await B.request('profile:set', { displayName: 'Bob', avatar: big })
    t.is(bProfile.avatar, big, 'the avatar is under the storage cap and is kept at rest')

    const aReq = A.waitFor('event:member-join-request', (m) => m.spaceId === space.spaceId && m.publicKey === bKey)
    await B.request('space:join', { inviteCode: invite })
    const req = await aReq

    t.is(req.displayName, 'Bob', 'the approver is told who is knocking')
    t.is(req.avatar, null, 'without the picture — which renders as initials, the same as any avatar-less peer')

    // The degradation is confined to the frame: B still holds the avatar, and it reaches members
    // over the profile bee once B is admitted.
    t.is((await B.request('profile:get')).avatar, big, 'the joiner did not lose its avatar')

    const bGranted = B.waitFor('event:membership-granted', (m) => m.spaceId === space.spaceId)
    await A.request('space:approve-member', { spaceId: space.spaceId, publicKey: bKey })
    await bGranted

    const roster = await A.until('space:members', { spaceId: space.spaceId },
      (list) => Array.isArray(list) && list.some((m) => m.publicKey === bKey && m.avatar === big), { ms: 60000 })
    t.ok(roster, 'and the full avatar arrives over the profile bee after approval')
  })
