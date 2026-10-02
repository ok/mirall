import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import type { ChosenRecoveryFile } from '../../hooks/useRecoveryFileChoice.js'
import Icon from '../primitives/Icon.js'
import TextButton from '../primitives/TextButton.js'

interface RecoveryFileChoiceProps {
  file: ChosenRecoveryFile | null
  onChoose: () => void
  onChange: () => void
  // While the dialog works on the chosen key, the choice cannot change under it.
  disabled?: boolean
}

// The chosen key, or the button that chooses one. Named by its label alone; the file-type hint is its
// description, so a screen reader hears one short name.
export default function RecoveryFileChoice({ file, onChoose, onChange, disabled = false }: RecoveryFileChoiceProps) {
  const { t, i18n } = useTranslation()
  const hintId = useId()
  if (file) {
    const createdMs = Date.parse(file.createdAt)
    const created = Number.isNaN(createdMs) ? null : new Date(createdMs).toLocaleDateString(i18n.language)
    return (
      <div className="bg-surface-container-low rounded-xl p-4 flex items-center gap-4">
        <Icon name="description" className="text-secondary" />
        <div className="min-w-0 flex-1">
          <p className="font-bold text-on-surface truncate">{file.fileName}</p>
          {created && <p className="text-sm text-on-surface-variant">{t('recoveryRestore.createdAt', { date: created })}</p>}
        </div>
        <TextButton onClick={() => { if (!disabled) onChange() }}>{t('actions.change')}</TextButton>
      </div>
    )
  }
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onChoose}
      aria-label={t('recoveryRestore.chooseFile')}
      aria-describedby={hintId}
      aria-disabled={disabled || undefined}
      className="w-full rounded-2xl border-2 border-dashed border-outline bg-surface-container-low p-8 text-center focus-ring aria-disabled:opacity-50 aria-disabled:cursor-not-allowed"
    >
      <span className="block font-bold text-on-surface">{t('recoveryRestore.chooseFile')}</span>
      <span id={hintId} className="block mt-1 text-sm text-on-surface-variant">{t('recoveryRestore.fileHint')}</span>
    </button>
  )
}
