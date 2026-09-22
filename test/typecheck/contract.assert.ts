// Compiled by `npm run typecheck`, never run. Each @ts-expect-error line asserts that a value the
// contract does not declare fails to compile; a widened union makes the directive itself an error.
import type { RequestName } from '../../src/shared/contract/requests.js'
import type { EventName } from '../../src/shared/contract/events.js'
import type { FileStatus, OwnedMountStatus } from '../../src/renderer/types/types.js'
import type { DecodedInvite } from '../../src/shared/contract/invite-envelope.js'
import type { DocsTarget } from '../../src/renderer/shell/docs-links.js'
import type { MainQueryName } from '../../src/renderer/store/main-queries.js'
import type { PublishOrder } from '../../src/shared/contract/paths.js'
import type { RequestResponse } from '../../src/shared/contract/responses.js'
import type { PathHost } from '../../src/shared/contract/paths.js'

const request: RequestName = 'spaces:list'
// @ts-expect-error a mistyped request name
const requestTypo: RequestName = 'spces:list'

const event: EventName = 'event:reconcile'
// @ts-expect-error a name nothing emits
const eventTypo: EventName = 'event:reconciled'

const fileStatus: FileStatus = 'downloaded'
// @ts-expect-error not a file status
const fileStatusTypo: FileStatus = 'not-a-status'

const ownedStatus: OwnedMountStatus = 'scanning'
// @ts-expect-error mirror-only, not in the owned tuple
const ownedStatusIdle: OwnedMountStatus = 'idle'

const invite: DecodedInvite = { v: 1, topic: '', name: '', owner: '', creator: '', schemaVersion: 2, autoAdmit: true, inviteId: '', expiresAt: 1 }
// @ts-expect-error a v0 invite carries only the topic
const inviteV0: DecodedInvite = { v: 0, topic: '', name: '' }

const docs: DocsTarget = { page: 'guides', anchor: 'create-a-space' }
// @ts-expect-error an anchor the site does not have
const docsTypo: DocsTarget = { page: 'guides', anchor: 'nope' }

const publishOrder: PublishOrder = 'smallest-first'
// @ts-expect-error a fresh string-literal array widens to string[] unless it is a const tuple
const publishOrderTypo: PublishOrder = 'random'

const mainQuery: MainQueryName = 'main:prefs'
// @ts-expect-error not a main fact
const mainQueryTypo: MainQueryName = 'main:nope'

const pathHost: PathHost = 'daemon'
// @ts-expect-error a path belongs to the daemon or the client, and nothing else
const pathHostTypo: PathHost = 'server'

const spacesList: RequestResponse['spaces:list'] = []
// @ts-expect-error a response is keyed by a declared request, not by any string
type NoSuchResponse = RequestResponse['spces:list']
// @ts-expect-error spaces:list resolves with a list, not one space
const spacesListWrong: RequestResponse['spaces:list'] = { spaceId: '' }
// @ts-expect-error an acknowledgement carries nothing but ok
const ackExtra: RequestResponse['files:remove'] = { ok: true, removed: 1 }
declare const maybeProfile: RequestResponse['profile:get']
// @ts-expect-error profile:get may be null, and the caller has to say what it does then
const name: string = maybeProfile.displayName

const approvedAlready: RequestResponse['space:approve-member'] = { granted: false, outcome: 'already-approved' }
// @ts-expect-error an approve that grants nothing says why, and only already-approved is a reason
const approvedDenied: RequestResponse['space:approve-member'] = { granted: false, outcome: 'denied' }
const denied: RequestResponse['space:deny-member'] = { outcome: 'already-approved' }
// @ts-expect-error a deny reports what it did, so a bare boolean cannot hide the no-op
const deniedBool: RequestResponse['space:deny-member'] = false
// @ts-expect-error not a deny outcome
const deniedTypo: RequestResponse['space:deny-member'] = { outcome: 'removed' }

void [pathHost, pathHostTypo, spacesList, spacesListWrong, ackExtra, name, approvedAlready, approvedDenied, denied, deniedBool, deniedTypo] as unknown as NoSuchResponse

void [request, requestTypo, event, eventTypo, fileStatus, fileStatusTypo, ownedStatus, ownedStatusIdle, invite, inviteV0, docs, docsTypo, publishOrder, publishOrderTypo, mainQuery, mainQueryTypo]
