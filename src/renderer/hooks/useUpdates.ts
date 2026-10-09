import { useState, useEffect } from 'react'
import { getUpdateState, onUpdateState, dismissUpdate } from '../platform/updates.js'
import { stagedVersion } from '../platform/update-state.js'

export function useUpdates() {
  const [state, setState] = useState(getUpdateState())

  useEffect(() => onUpdateState(setState), [])

  return { status: state.status, update: stagedVersion(state.status), dismissed: state.dismissed, dismiss: dismissUpdate }
}
