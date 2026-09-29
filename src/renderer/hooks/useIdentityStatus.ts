// Whether the worker could open this device's identity. A query rather than a pushed event: the store
// re-reads it for every new worker, and a reloaded window never sees a push its connection missed.
// Only an answer makes it `known` — a failed read is asked again, never taken as "unlocked", because
// the gate it feeds exists to keep onboarding off a locked identity. `loading` is not read: it
// re-raises on every re-read.
import { useEffect } from 'react'
import { useQuery } from '../store/useQuery.js'
import { refetchQuery, setQueryData } from '../store/query-store.js'
import { restartWorker } from '../ipc/ipc.js'
import type { IdentityStatus } from '../../shared/contract/responses.js'
import type { IdentityLockCode } from '../../shared/contract/errors.js'

const RETRY_MS = 1000

export interface IdentityStatusView {
  known: boolean
  locked: boolean
  code: IdentityLockCode | null
}

export function useIdentityStatus(): IdentityStatusView {
  const { data, error } = useQuery('identity:status', {}, null)
  const unanswered = data == null && error != null

  useEffect(() => {
    if (!unanswered) return undefined
    const timer = setTimeout(() => {
      refetchQuery('identity:status').catch((err: Error) => console.warn('identity status re-read failed:', err.message))
    }, RETRY_MS)
    return () => clearTimeout(timer)
  }, [unanswered, error])

  return { known: data != null, locked: data?.locked === true, code: data?.code ?? null }
}

// A restart that may change the answer: the old one is dropped first, so the shell shows the boot
// screen until the new worker says whether it is locked, rather than the previous worker's answer.
export async function restartIntoIdentity(): Promise<void> {
  setQueryData<IdentityStatus | null>('identity:status', {}, null)
  try {
    await restartWorker()
  } catch (err) {
    // No new worker will re-read it, so the one still running is asked again.
    await refetchQuery('identity:status').catch(() => null)
    throw err
  }
}
