// The batch's own polite region: one count-free sentence when a batch starts and one when it
// ends. The strip's counts change twice a second, so the strip itself is never live, and this
// region is always mounted so the end is voiced too.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

export default function BatchAnnouncement({ live }: { live: boolean }) {
  const { t } = useTranslation()
  const [ended, setEnded] = useState(false)
  const [wasLive, setWasLive] = useState(live)
  if (wasLive !== live) {
    setWasLive(live)
    setEnded(!live)
  }
  return (
    <div role="status" aria-live="polite" className="sr-only">
      {live ? t('batch.progressAnnounce') : ended ? t('batch.progressEnded') : ''}
    </div>
  )
}
