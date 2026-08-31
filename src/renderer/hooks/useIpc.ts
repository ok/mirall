import type { RequestName } from '../../shared/contract/requests.js'
import { useState, useEffect, useCallback } from 'react'
import { request } from '../ipc.js'

export function useIpcQuery(type: RequestName, payload: Record<string, unknown>, deps: React.DependencyList = []) {
  const [data, setData] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const result = await request(type, payload)
      setData(result)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, deps)

  useEffect(() => { refresh() }, [refresh])

  return { data, loading, error, refresh }
}
