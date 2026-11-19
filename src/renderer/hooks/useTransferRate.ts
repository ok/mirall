// The current transfer rate of this device, as the worker's meter reports it once a second while
// bytes move. Local state per consumer: a rate is a reading, not shared status.
import { useEffect, useState } from 'react'
import { subscribe } from '../ipc/ipc.js'

export interface TransferRate {
  /** Bytes per second. */
  down: number
  up: number
  /** A mirrored folder is fetching, which the list of transfers does not show. */
  mirror: boolean
}

const IDLE: TransferRate = { down: 0, up: 0, mirror: false }
// Rate frames are not replayed, so a missed final frame would freeze the last rate on screen.
const STALE_MS = 3000

export function useTransferRate(): TransferRate {
  const [rate, setRate] = useState(IDLE)
  useEffect(() => {
    let stale: ReturnType<typeof setTimeout> | undefined
    const unsub = subscribe<TransferRate>('event:transfer-rate', (m) => {
      clearTimeout(stale)
      const moving = m.down > 0 || m.up > 0
      setRate(moving ? { down: m.down, up: m.up, mirror: m.mirror } : IDLE)
      if (moving) stale = setTimeout(() => setRate(IDLE), STALE_MS)
    })
    return () => { unsub(); clearTimeout(stale) }
  }, [])
  return rate
}
