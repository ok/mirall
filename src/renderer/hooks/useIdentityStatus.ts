// Whether the worker could open this device's identity. A query rather than a pushed event: the store
// re-reads it for every new worker, and a reloaded window never sees a push its connection missed.
// Only an answer makes it `known` — a failed read is asked again, never taken as "unlocked", because
// the gate it feeds exists to keep onboarding off a locked identity. `loading` is not read: it
// re-raises on every re-read.
import { useCallback, useEffect, useState } from 'react'
import { useQuery } from '../store/useQuery.js'
import { refetchQuery, setQueryData } from '../store/query-store.js'
import { restartWorker } from '../ipc/ipc.js'
import type { IdentityStatus, RestoreStatus } from '../../shared/contract/responses.js'
import { RESTORE_SCOPES } from '../store/scopes.js'
import type { IdentityLockCode } from '../../shared/contract/errors.js'

const RETRY_MS = 1000

export interface IdentityStatusView {
  known: boolean
  locked: boolean
  code: IdentityLockCode | null
  restore: RestoreStatus | null
  restartFailed: boolean
  retryRestart: () => void
}

export function useIdentityStatus(): IdentityStatusView {
  const { data, error } = useQuery('identity:status', {}, RESTORE_SCOPES)
  const unanswered = data == null && error != null

  useEffect(() => {
    if (!unanswered) return undefined
    const timer = setTimeout(() => {
      refetchQuery('identity:status').catch((err: Error) => console.warn('identity status re-read failed:', err.message))
    }, RETRY_MS)
    return () => clearTimeout(timer)
  }, [unanswered, error])

  // A released profile restarts the worker into a normal boot underneath the app, which stays as it is;
  // a restart that fails is said in the restore banner, with a retry.
  const released = data?.restore?.profile?.released === true
  const [restartFailed, setRestartFailed] = useState(false)
  const [restartAttempt, setRestartAttempt] = useState(0)
  useEffect(() => {
    if (!released) return undefined
    let live = true
    restartWorker().catch((err: Error) => {
      console.warn('restart after the restore failed:', err.message)
      if (live) setRestartFailed(true)
    })
    return () => { live = false }
  }, [released, restartAttempt])
  const retryRestart = useCallback(() => {
    setRestartFailed(false)
    setRestartAttempt((n) => n + 1)
  }, [])

  return {
    known: data != null,
    locked: data?.locked === true,
    code: data?.code ?? null,
    restore: data?.restore ?? null,
    restartFailed,
    retryRestart,
  }
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
