import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '../components/toast/ToastProvider.js'
import { useRunAction } from './useRunAction.js'
import { loadAllEntries } from '../platform/changelog.js'
import * as whatsNew from '../platform/whats-new.js'

// Every release's notes, from the Account row and from the command palette. A changelog with no
// entries says so rather than opening nothing.
export function useOpenWhatsNew(): () => void {
  const { t } = useTranslation()
  const toast = useToast()
  const run = useRunAction()
  return useCallback(() => run(async () => {
    const all = await loadAllEntries()
    if (all.length) whatsNew.open(all, 'all')
    else toast.info(t('aboutSettings.whatsNewEmpty'))
  }), [run, toast, t])
}
