// Owns the local profile and the needs-setup flag; listens for event:profile-needed and saves via profile:set.
import { useState, useEffect } from 'react'
import { request, subscribe } from '../ipc.js'
import type { Profile } from '../types.js'

export function useProfile() {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [needsSetup, setNeedsSetup] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    request('profile:get').then((p) => {
      setProfile(p as Profile | null)
      setNeedsSetup(!p)
      setLoading(false)
    }).catch(() => {
      setNeedsSetup(true)
      setLoading(false)
    })

    const unsub = subscribe('event:profile-needed', () => {
      setNeedsSetup(true)
      setLoading(false)
    })
    return unsub
  }, [])

  async function saveProfile({ displayName, avatar }: { displayName: string; avatar: string | null }) {
    const updated = await request('profile:set', { displayName, avatar }) as Profile
    setProfile(updated)
    setNeedsSetup(false)
    return updated
  }

  return { profile, needsSetup, loading, saveProfile }
}
