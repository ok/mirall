// The transfer rate history for one chart window, re-read at the pace the window gains points.
import { useEffect, useState } from 'react'
import { request } from '../ipc/ipc.js'
import { RATE_WINDOW } from '../../shared/contract/rate-window.js'
import type { RateWindow } from '../../shared/contract/rate-window.js'
import type { TransferRateSample } from '../../shared/contract/responses.js'

const NONE: TransferRateSample[] = []
const REFRESH_MS: Record<RateWindow, number> = { [RATE_WINDOW.MINUTES]: 2000, [RATE_WINDOW.HOUR]: 12_000, [RATE_WINDOW.TODAY]: 60_000 }

export function useRateHistory(window: RateWindow): { samples: TransferRateSample[]; readAt: number } {
  const [history, setHistory] = useState({ samples: NONE, readAt: Date.now() })
  useEffect(() => {
    let alive = true
    const read = () => {
      // A read that fails keeps the last history on screen: the next one replaces it.
      request('transfers:rates', { window }).then((samples) => {
        if (alive) setHistory({ samples: samples ?? NONE, readAt: Date.now() })
      }, (err) => { console.warn('transfer rate history read failed', err) })
    }
    setHistory({ samples: NONE, readAt: Date.now() })
    read()
    const timer = setInterval(read, REFRESH_MS[window])
    return () => { alive = false; clearInterval(timer) }
  }, [window])
  return history
}
