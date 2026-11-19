// The transfers page's limits tile: the download and the upload limit, each a menu of the presets
// Network settings offers. A limit that is none of them is set on that screen.
import { useTranslation } from 'react-i18next'
import { useBandwidthLimits } from '../../hooks/useBandwidthLimits.js'
import { PRESET_KBPS, limitLabel } from '../../model/bandwidth-presets.js'
import type { BandwidthLimits } from '../../platform/global.js'
import ActionMenu, { type ActionMenuItemConfig } from '../primitives/ActionMenu.js'
import Icon from '../primitives/Icon.js'
import InlineError from '../primitives/InlineError.js'
import TextButton from '../primitives/TextButton.js'

type Direction = 'download' | 'upload'
const KEY: Record<Direction, keyof BandwidthLimits> = { download: 'downloadKBps', upload: 'uploadKBps' }

interface TransferLimitsCardProps {
  onOpenNetworkSettings: () => void
}

export default function TransferLimitsCard({ onOpenNetworkSettings }: TransferLimitsCardProps) {
  const { t } = useTranslation()
  const { limits, readError, applying, saveFailed, apply } = useBandwidthLimits()
  const unlimited = t('networkSettings.unlimited')

  const row = (direction: Direction, current: BandwidthLimits) => {
    const kbps = current[KEY[direction]]
    const pick = (preset: number) => {
      if (preset === kbps) return
      apply({ ...current, [KEY[direction]]: preset })
    }
    const items: ActionMenuItemConfig[] = [
      ...PRESET_KBPS.map((preset) => ({
        id: String(preset),
        label: limitLabel(preset, unlimited),
        icon: preset === kbps ? 'check' as const : undefined,
        checked: preset === kbps,
        disabled: applying,
        onAction: () => pick(preset),
      })),
      { id: 'custom', label: t('transfers.limitCustom'), separatorBefore: true, onAction: onOpenNetworkSettings },
    ]
    const value = limitLabel(kbps, unlimited)
    return (
      <div className="flex items-center justify-between gap-3">
        <p className="font-semibold text-accent">{t(`networkSettings.${direction}`)}</p>
        <ActionMenu
          label={value}
          triggerVariant="neutral"
          ariaLabel={t(`networkSettings.a11y.${direction}Preset`, { rate: value })}
          items={items}
        />
      </div>
    )
  }

  return (
    <div className="bg-surface-container-low rounded-2xl p-8">
      <div className="flex items-center gap-2 mb-6">
        <Icon name="tune" className="text-secondary shrink-0" />
        <h3 className="text-xl font-headline font-bold text-accent">{t('networkSettings.transferLimits')}</h3>
      </div>
      {/* With no limit read yet the rows are not drawn: 0 means unlimited, so it cannot stand in
          for "not known". */}
      {limits ? (
        <div className="space-y-4">
          {row('download', limits)}
          {row('upload', limits)}
          {saveFailed && <InlineError>{t('networkSettings.limitSaveFailed')}</InlineError>}
        </div>
      ) : readError ? (
        <InlineError>{t('networkSettings.limitsUnavailable')}</InlineError>
      ) : (
        <p role="status" className="text-sm text-on-surface-variant">{t('networkSettings.limitsLoading')}</p>
      )}
      <div className="flex justify-end mt-6">
        <TextButton onClick={onOpenNetworkSettings}>{t('transfers.networkSettings')}</TextButton>
      </div>
    </div>
  )
}
