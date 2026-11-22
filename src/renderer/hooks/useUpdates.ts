import { useState, useEffect } from 'react'
import { getUpdateState, onUpdateState, dismissUpdate, installUpdate } from '../platform/updates.js'
import { bannerUpdate } from '../platform/update-state.js'
import { useRunAction } from './useRunAction.js'

export function useUpdates() {
  const [state, setState] = useState(getUpdateState())

  useEffect(() => onUpdateState(setState), [])

  return { status: state.status, banner: bannerUpdate(state.status), dismissed: state.dismissed, dismiss: dismissUpdate }
}

// Update from outside About (the banner, the command palette): About opens, where the download shows.
export function useInstallUpdate(openAbout: () => void): () => void {
  const runAction = useRunAction()
  return () => {
    openAbout()
    runAction(installUpdate)
  }
}
