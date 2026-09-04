// Owns the spaces list plus create/join/invite actions; refreshes on event:state, membership reconcile hints, and the grant/deny/divergence events.
import { useEffect } from 'react'
import { request } from '../ipc.js'
import { useQuery } from '../store/useQuery.js'
import { refetchQuery, invalidateKey } from '../store/query-store.js'
import { SPACES_SCOPES } from '../store/scopes.js'
import { pruneRosterCache } from './useSpaceMembers.js'
import { pruneMirrorCache } from './useSpaceMirrors.js'
import { pruneSpaceCardState } from './useSpaceCardState.js'
import { pruneShareCache } from './useShares.js'
import type { Space } from '../types.js'

const SPACE_SCOPED_REQUESTS = ['members:online', 'space:pending-requests', 'space:storage-summary']

function pruneSpaceScopedQueries(liveSpaceIds: string[]) {
  const live = new Set(liveSpaceIds)
  invalidateKey((key) => {
    const type = key.split('?')[0]
    if (!SPACE_SCOPED_REQUESTS.includes(type)) return false
    const match = /spaceId=([^&]*)/.exec(key)
    return match ? !live.has(match[1]) : false
  })
}

// The store keeps the last-known list across mounts, which the home screen needs: it unmounts on
// every trip into a space, and without a cached value each return would paint the "no spaces yet"
// hero over an account that has spaces while spaces:list resolves.
export function useSpaces() {
  const { data, loading: fetching } = useQuery<Space[]>('spaces:list', {}, SPACES_SCOPES)
  const spaces = data ?? []
  // Only a genuinely cold list reports loading. A reconcile-driven refetch keeps the rows on
  // screen, and flipping this back to true would blink the "no favorites yet" hero on every member
  // join, leave or avatar change.
  const loading = data === undefined && fetching

  // The prune side-effects follow the list wherever it came from — a fetch or an event:state push.
  useEffect(() => {
    if (!data) return
    const ids = data.map((s) => s.spaceId)
    pruneRosterCache(ids)
    pruneMirrorCache(ids)
    pruneSpaceCardState(ids)
    pruneShareCache(ids)
    // The migration moved three more per-space reads into the store. Without this a left space
    // keeps its online set, pending join requests and storage summary for the session, and
    // re-joining the same id paints them instantly — what the prune helpers exist to prevent.
    pruneSpaceScopedQueries(ids)
  }, [data])

  // refetchQuery, not fetchQuery: every mutation below awaits this, and joining a read that started
  // before the write committed would resolve with the pre-mutation list — a newly created space
  // would not appear until the next hint.
  async function refresh() {
    await refetchQuery<Space[]>('spaces:list', {}, SPACES_SCOPES).catch(() => {})
  }

  // No subscriptions and no mount-time refresh. useQuery already fetches on mount, so refetchQuery
  // here only abandoned that read to issue a second one — five times over, because five components
  // call this hook and several are mounted together. The event:state push and the three membership
  // re-reads moved to installPushBridges, which holds one subscription for the app; `refresh` stays
  // for the mutations below, where one call really is one user action.

  async function createSpace(name: string, icon: string) {
    const space = await request('space:create', { name, icon }) as Space
    await refresh()
    return space
  }

  async function joinSpace(inviteCode: string, name: string) {
    const space = await request('space:join', { inviteCode, name }) as Space
    await refresh()
    return space
  }

  async function createInvite(spaceId: string, opts: { autoApprove?: boolean; expiresInMs?: number } = {}) {
    return await request('space:invite', { spaceId, autoAdmit: !!opts.autoApprove, expiresInMs: opts.expiresInMs }) as string
  }

  async function approveMember(spaceId: string, publicKey: string) {
    await request('space:approve-member', { spaceId, publicKey })
    await refresh()
  }

  async function denyMember(spaceId: string, publicKey: string) {
    await request('space:deny-member', { spaceId, publicKey })
    await refresh()
  }

  async function leaveSpace(spaceId: string) {
    await request('space:leave', { spaceId })
    await refresh()
  }

  async function updateSpace(spaceId: string, name: string, icon: string, downloadFolder?: string | null) {
    const space = await request('space:update', {
      spaceId,
      name,
      icon,
      ...(downloadFolder !== undefined ? { downloadFolder } : {}),
    }) as Space
    await refresh()
    return space
  }

  async function toggleFavorite(spaceId: string) {
    await request('space:toggle-favorite', { spaceId })
    await refresh()
  }

  return { spaces, loading, createSpace, joinSpace, createInvite, leaveSpace, updateSpace, toggleFavorite, approveMember, denyMember, refresh }
}
