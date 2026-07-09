import { useTranslation } from 'react-i18next'
import Icon, { type IconName } from '../primitives/Icon.js'

export const iconOptions: Array<{ id: IconName }> = [
  { id: 'folder' },
  { id: 'movie' },
  { id: 'science' },
  { id: 'photo_camera' },
  { id: 'palette' },
  { id: 'work' },
  { id: 'music_note' },
  { id: 'bar_chart' },
  { id: 'code' },
  { id: 'architecture' },
  { id: 'menu_book' },
  { id: 'edit_note' },
  { id: 'cloud' },
  { id: 'shield' },
  { id: 'school' },
  { id: 'hub' },
]

interface IconPickerProps {
  selected: string
  onSelect: (icon: string) => void
}

export default function IconPicker({ selected, onSelect }: IconPickerProps) {
  const { t } = useTranslation()
  return (
    <div role="group" aria-label={t('iconPicker.groupLabel')} className="flex flex-wrap gap-3">
      {iconOptions.map((opt) => (
        <button
          key={opt.id}
          type="button"
          onClick={() => onSelect(opt.id)}
          aria-label={t(`iconPicker.${opt.id}`)}
          aria-pressed={selected === opt.id}
          className={`w-12 h-12 flex items-center justify-center rounded-full border-2 transition-all active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30 ${
            selected === opt.id
              ? 'bg-primary text-on-primary border-primary'
              : 'bg-surface-container-low text-on-surface-variant border-transparent hover:bg-surface-container-high hover:border-outline-variant'
          }`}
          title={t(`iconPicker.${opt.id}`)}
        >
          <Icon name={opt.id} size={20} />
        </button>
      ))}
    </div>
  )
}
