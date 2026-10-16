// Where this space's downloads go, named in the controls row above the rows, and the way to change
// it. A pick here changes the folder and downloads nothing. A folder on a drive that is not connected
// shows in the warning tone.
import { useTranslation } from 'react-i18next'
import ActionMenu from '../primitives/ActionMenu.js'
import type { DownloadTo } from '../../hooks/useDownloadTo.js'

interface DownloadsToButtonProps {
  downloadTo: DownloadTo
}

export default function DownloadsToButton({ downloadTo }: DownloadsToButtonProps) {
  const { t } = useTranslation()
  const current = downloadTo.current
  if (!current) return null
  const { name, offline } = current
  const label = offline ? t('downloadTo.buttonOffline', { folder: name }) : name
  return (
    <ActionMenu
      triggerVariant="neutral"
      triggerTone={offline ? 'warning' : 'default'}
      icon={offline ? 'warning' : 'download'}
      label={label}
      // The name carries the visible label word for word, the not-connected state included.
      ariaLabel={t('downloadTo.buttonAria', { folder: label })}
      title={current.shown}
      maxWidthClass="max-w-[16rem]"
      {...downloadTo.menu(downloadTo.setFolder)}
    />
  )
}
