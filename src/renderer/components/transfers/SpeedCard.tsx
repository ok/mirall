// The transfers page's speed tile: the current download and upload rate, and their history as one
// chart with download above the zero line and upload below it.
import { useMemo, useState } from 'react'
import type { PointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useTransferRate } from '../../hooks/useTransferRate.js'
import { useRateHistory } from '../../hooks/useRateHistory.js'
import { formatSpeed } from '../../format/utils.js'
import { nearestSample, speedChart } from '../../model/speed-chart.js'
import { windowSpan } from '../../model/speed-windows.js'
import { RATE_WINDOW, RATE_WINDOWS } from '../../../shared/contract/rate-window.js'
import type { RateWindow } from '../../../shared/contract/rate-window.js'
import Icon from '../primitives/Icon.js'
import SegmentedControl, { Segment } from '../primitives/SegmentedControl.js'

const BOX = { width: 236, height: 150, left: 0, right: 0, top: 6, bottom: 18 }
const WINDOW_LABEL: Record<RateWindow, string> = { '5m': 'transfers.window5m', '1h': 'transfers.window1h', today: 'transfers.windowToday' }
const WINDOW_NAME: Record<RateWindow, string> = { '5m': 'transfers.windowName5m', '1h': 'transfers.windowName1h', today: 'transfers.windowNameToday' }

// One rate per line, label left and figure right: side by side, two figures as wide as
// "999.9 MB/s" do not fit the tile.
function Figure({ dot, label, value }: { dot: string; label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <p className="flex items-center gap-2 text-xs font-medium text-on-surface-variant">
        <span aria-hidden="true" className={`w-2.5 h-2.5 rounded-full shrink-0 ${dot}`} />
        {label}
      </p>
      <p className="text-2xl font-headline font-extrabold text-accent tracking-tight leading-tight tabular-nums whitespace-nowrap">{value}</p>
    </div>
  )
}

export default function SpeedCard() {
  const { t } = useTranslation()
  const rate = useTransferRate()
  const [window, setWindow] = useState<RateWindow>(RATE_WINDOW.MINUTES)
  const { samples, readAt } = useRateHistory(window)
  const chart = useMemo(() => speedChart(samples, windowSpan(window, readAt), BOX), [samples, window, readAt])
  const [hover, setHover] = useState(-1)
  const down = formatSpeed(rate.down)
  const up = formatSpeed(rate.up)
  const point = hover >= 0 && hover < samples.length ? samples[hover] : null

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left
    setHover(nearestSample(chart.xs, x))
  }

  return (
    <div className="bg-surface-container-low rounded-2xl p-8">
      <div className="flex items-center gap-2 mb-6">
        <Icon name="bar_chart" className="text-secondary shrink-0" />
        <h3 className="text-xl font-headline font-bold text-accent">{t('transfers.speed')}</h3>
      </div>
      <div className="space-y-1">
        <Figure dot="bg-chart-1" label={t('networkSettings.download')} value={down} />
        <Figure dot="bg-chart-2" label={t('networkSettings.upload')} value={up} />
      </div>
      <div className="relative mt-5">
        <svg
          width={BOX.width}
          height={BOX.height}
          viewBox={`0 0 ${BOX.width} ${BOX.height}`}
          role="img"
          aria-label={t('transfers.chartLabel', { window: t(WINDOW_NAME[window]), down, up })}
          className="block overflow-visible"
          onPointerMove={onMove}
          onPointerLeave={() => setHover(-1)}
        >
          {chart.ticks.map((tick) => (
            <line key={tick.y} x1={BOX.left} x2={BOX.width} y1={tick.y} y2={tick.y} className={tick.rate === 0 ? 'stroke-outline' : 'stroke-outline-variant'} strokeWidth={1} />
          ))}
          <path d={chart.downArea} className="fill-chart-1" opacity={0.22} />
          <path d={chart.upArea} className="fill-chart-2" opacity={0.22} />
          <path d={chart.downLine} fill="none" className="stroke-chart-1" strokeWidth={2} strokeLinejoin="round" />
          <path d={chart.upLine} fill="none" className="stroke-chart-2" strokeWidth={2} strokeLinejoin="round" />
          {/* The two ends of the scale are labelled; the lines between them are not. */}
          {[chart.ticks[0], chart.ticks[3]].map((tick) => (
            <text key={tick.y} x={BOX.left + 2} y={tick.y + (tick.y > chart.zeroY ? -3 : 11)} className="fill-on-surface-variant text-[10px] tabular-nums">{formatSpeed(tick.rate)}</text>
          ))}
          <text x={BOX.width} y={BOX.height - 2} textAnchor="end" className="fill-on-surface-variant text-[10px]">{t('transfers.chartNow')}</text>
          {point && <line x1={chart.xs[hover]} x2={chart.xs[hover]} y1={BOX.top} y2={BOX.height - BOX.bottom} className="stroke-on-surface-variant" strokeWidth={1} />}
        </svg>
        {point && (
          <div
            aria-hidden="true"
            className="absolute z-10 -translate-x-1/2 -translate-y-full pointer-events-none whitespace-nowrap bg-surface-container-lowest rounded-lg shadow-lg px-3 py-2 text-xs text-on-surface tabular-nums"
            style={{ left: Math.min(Math.max(chart.xs[hover], 70), BOX.width - 70), top: BOX.top - 4 }}
          >
            <p className="text-on-surface-variant mb-1">{new Date(point.t).toLocaleTimeString()}</p>
            <p className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-chart-1" />{t('networkSettings.download')}<b className="ml-auto pl-3">{formatSpeed(point.down)}</b></p>
            <p className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-chart-2" />{t('networkSettings.upload')}<b className="ml-auto pl-3">{formatSpeed(point.up)}</b></p>
          </div>
        )}
      </div>
      <SegmentedControl className="mt-4 w-fit mx-auto">
        {RATE_WINDOWS.map((id) => (
          <Segment key={id} label={t(WINDOW_LABEL[id])} ariaLabel={t('transfers.windowNamed', { window: t(WINDOW_NAME[id]) })} selected={window === id} onSelect={() => setWindow(id)} />
        ))}
      </SegmentedControl>
      {rate.mirror && <p className="mt-4 text-sm font-medium text-on-surface-variant">{t('transfers.mirrorSyncing')}</p>}
    </div>
  )
}
