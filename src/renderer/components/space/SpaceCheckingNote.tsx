// A space whose own file list is still being confirmed after a backup restore, once the profile is:
// sharing here waits until then.
import { useTranslation } from 'react-i18next'
import { useRestoreHold } from '../../hooks/useRestoreHold.js'
import { useSpaces } from '../../hooks/useSpaces.js'
import Callout from '../primitives/Callout.js'

interface SpaceCheckingNoteProps {
  spaceId: string
}

export default function SpaceCheckingNote({ spaceId }: SpaceCheckingNoteProps) {
  const { t } = useTranslation()
  const hold = useRestoreHold()
  const { spaces } = useSpaces()
  if (!hold.canWriteProfile || hold.canShareIn(spaceId)) return null
  const name = spaces.find((space) => space.spaceId === spaceId)?.name ?? ''
  return (
    <Callout tone="note" title={t('restore.checkingSpaceTitle', { name })} className="shrink-0 mb-4">
      {t('restore.checkingSpaceBody')}
    </Callout>
  )
}
