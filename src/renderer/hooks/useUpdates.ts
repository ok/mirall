import { useState, useEffect } from 'react'
import { getUpdateState, onUpdateState, dismissUpdate } from '../updates.js'

export function useUpdates() {
  const [state, setState] = useState(getUpdateState())

  useEffect(() => onUpdateState(setState), [])

  // `update` is the raw staged-update fact; `dismissed` only governs the banner.
  // The banner consumer should hide on `dismissed`; the About notice ignores it.
  return { update: state.update, dismissed: state.dismissed, dismiss: dismissUpdate }
}
