// Owns the local profile and the needs-setup flag; listens for event:profile-needed and saves via profile:set.
import { useCallback, useEffect, useState } from 'react'
import { request, subscribe } from '../ipc.js'
import { useQuery } from '../store/useQuery.js'
import { setQueryData } from '../store/query-store.js'
import { projectProfile } from '../profileGate.js'
import type { Profile } from '../types.js'

// Three screens call this hook, so the hand-rolled read it replaces was three `profile:get` round
// trips per session for one fact. Scope-less deliberately: the profile changes only when this app
// writes it, and saveProfile pushes the new record into the entry rather than re-reading it.
//
// The store's `loading` is deliberately not read here — see profileGate.js for why gating the app
// shell on it turns every re-read into a full remount of the tree.
export function useProfile() {
  const { data, error } = useQuery<Profile | null>('profile:get', {}, null)
  // The worker's own "there is no profile yet" signal, which is not a reconcile poke and has no
  // scope: it announces a state the read cannot report, because it fires before a read would.
  const [profileNeeded, setProfileNeeded] = useState(false)

  useEffect(() => subscribe('event:profile-needed', () => setProfileNeeded(true)), [])

  const saveProfile = useCallback(async ({ displayName, avatar }: { displayName: string; avatar: string | null }) => {
    const updated = await request('profile:set', { displayName, avatar }) as Profile
    // Pushed, not refetched: the worker just told us the new record, and every other consumer of
    // this entry must see it in the same commit rather than one round trip later.
    setQueryData<Profile | null>('profile:get', {}, updated)
    setProfileNeeded(false)
    return updated
  }, [])

  return { ...projectProfile({ data, error, profileNeeded }), saveProfile }
}
