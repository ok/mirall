// Idle share target on a space screen: dashed drop area with a Browse menu for picking
// files or a folder; fades out while a drag is active so DropOverlay can take over.
import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import ActionMenu, { type ActionMenuItemConfig } from './ActionMenu.js'

interface DropZoneProps {
  onFilesSelected: (files: File[]) => void
  onFolderSelected?: (folderPath: string) => void
  folderSupportEnabled?: boolean
  dragActive?: boolean
}

export default function DropZone({
  onFilesSelected,
  onFolderSelected,
  folderSupportEnabled,
  dragActive = false,
}: DropZoneProps) {
  const { t } = useTranslation()
  const fileRef = useRef<HTMLInputElement>(null)
  const folderEnabled = folderSupportEnabled === true && typeof onFolderSelected === 'function'

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || [])
    if (files.length > 0) onFilesSelected(files)
    e.target.value = ''
  }

  const browseItems: ActionMenuItemConfig[] = [
    {
      id: 'files',
      label: t('dropZone.files'),
      icon: 'draft',
      onAction: () => fileRef.current?.click(),
    },
    {
      id: 'folder',
      label: t('dropZone.folder'),
      icon: 'folder',
      onAction: () => {
        if (folderEnabled && onFolderSelected) onFolderSelected('')
      },
      disabled: !folderEnabled,
      hint: folderEnabled ? undefined : t('dropZone.folderComingSoon'),
    },
  ]

  return (
    <div
      role="group"
      aria-label={t('dropZone.subtitle')}
      className={`flex flex-col items-center justify-center p-6 border-2 border-dashed border-outline bg-surface-container-low rounded-2xl min-h-[10.5rem] transition-opacity duration-200 motion-reduce:transition-none ${
        dragActive ? 'opacity-0 pointer-events-none' : 'opacity-100'
      }`}
    >
      <h3 className="text-lg font-headline font-bold text-accent mb-1 text-center">
        {t('dropZone.title')}
      </h3>
      <p className="text-xs text-on-surface-variant mb-4 text-center">
        {t('dropZone.subtitle')}
      </p>
      <ActionMenu label={t('dropZone.browse')} items={browseItems} />
      <input
        ref={fileRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFileInput}
      />
    </div>
  )
}
