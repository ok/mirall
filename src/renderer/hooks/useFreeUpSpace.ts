// "Free up": old app updates are pruned in main, the index is compacted and replaced records are
// requested for rewrite in the worker, and a worker restart runs that rewrite. Each step is a phase
// the screen announces; the result is the drop in the total the screen shows.
import { useCallback, useState } from 'react'
import { request, restartWorker } from '../ipc/ipc.js'
import { useRunAction } from './useRunAction.js'
import { storageCategories } from '../model/storage-categories.js'
import type { UpdateCacheInfo } from '../platform/global.js'

// Both wait on store compactions, which run as long as the store is large; 0 waits for the work.
const NO_TIMEOUT = 0

export type FreeUpPhase = 'idle' | 'updates' | 'records' | 'restarting' | 'measuring' | 'done'

export interface FreeUpOutcome { freed: number; total: number }

export function useFreeUpSpace(refreshUpdates: () => Promise<UpdateCacheInfo>) {
  const runAction = useRunAction()
  const [phase, setPhase] = useState<FreeUpPhase>('idle')
  const [outcome, setOutcome] = useState<FreeUpOutcome | null>(null)

  const start = useCallback((before: number) => {
    runAction(async () => {
      try {
        setPhase('updates')
        await window.bridge.pruneUpdateCache()
        setPhase('records')
        const { restartRequired } = await request('storage:free-up', {}, NO_TIMEOUT)
        if (restartRequired) {
          setPhase('restarting')
          await restartWorker()
        }
        setPhase('measuring')
        const info = await request('storage:measure', {}, NO_TIMEOUT)
        const total = storageCategories(info, await refreshUpdates()).total
        setOutcome({ freed: Math.max(0, before - total), total })
        setPhase('done')
      } catch (err) {
        setPhase('idle')
        throw err
      }
    })
  }, [runAction, refreshUpdates])

  return { phase, outcome, start }
}
