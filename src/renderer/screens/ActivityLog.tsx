import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useHasVerticalOverflow } from '../hooks/useHasVerticalOverflow.js'
import { useActivityFilters } from '../hooks/useActivityFilters.js'
import { useAuditLog } from '../hooks/useAuditLog.js'
import { groupByDay } from '../auditRow.js'
import type { AuditFilters } from '../types.js'
import Icon from '../components/primitives/Icon.js'
import ActivityFilterBar from '../components/activity/ActivityFilterBar.js'
import ActivityFeed from '../components/activity/ActivityFeed.js'
import PageHeader from '../components/layout/PageHeader.js'
import { useRegisterCommand } from '../keyboard/KeyboardProvider.js'

interface ActivityLogProps {
  onBack: () => void
  onOpenSettings: () => void
  initialFilters?: Partial<AuditFilters>
}

export default function ActivityLog({ onBack, onOpenSettings, initialFilters }: ActivityLogProps) {
  const { t } = useTranslation()
  const { ref, hasOverflow } = useHasVerticalOverflow<HTMLDivElement>()
  const f = useActivityFilters(initialFilters)
  const { entries, loading, loadingMore, error, hasMore, loadMore } = useAuditLog(f.filters, f.kinds)
  const groups = useMemo(() => groupByDay(entries), [entries])

  useRegisterCommand(
    {
      id: 'search.focus',
      labelKey: 'shortcuts.focusSearch',
      group: 'actions',
      when: (ctx) => ctx.currentScreen === 'activity-log',
      run: () => {
        f.searchRef.current?.focus()
        f.searchRef.current?.select()
      },
    },
    [],
  )

  return (
    <div
      ref={ref}
      className={`relative h-[calc(100vh-5.5rem-var(--banner-h,0px))] overflow-y-auto scrollbar-thin pb-8 mr-2 ${hasOverflow ? 'pr-4' : ''}`}
    >
      <div className="pt-8 px-8 max-w-2xl mx-auto">
        <PageHeader title={t('activityLog.title')} subtitle={t('activityLog.intro')} onBack={onBack} />

        <div className="space-y-10">
          <ActivityFilterBar
            filters={f.filters}
            setFilters={f.setFilters}
            active={f.active}
            toggleCategory={f.toggleCategory}
            clearAll={f.clearAll}
            spaces={f.spaces}
            actors={f.actors}
            spaceName={f.spaceName}
            actorName={f.actorName}
            rangeLabel={f.rangeLabel}
            searchRef={f.searchRef}
          />

          <ActivityFeed
            groups={groups}
            entries={entries}
            loading={loading}
            loadingMore={loadingMore}
            error={error}
            hasMore={hasMore}
            loadMore={loadMore}
            active={f.active}
            empty={f.empty}
            onClearFilters={f.clearAll}
          />

          <section>
            <button
              type="button"
              onClick={onOpenSettings}
              aria-label={t('activityLog.logSettings')}
              className="w-full bg-surface-container-low rounded-xl p-6 flex items-center gap-4 text-left hover:bg-surface-container-high/50 active:scale-[0.99] transition-all focus-ring cursor-pointer"
            >
              <div className="w-10 h-10 rounded-full bg-icon-tile flex items-center justify-center text-on-icon-tile shrink-0">
                <Icon name="tune" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-accent">{t('activityLog.logSettings')}</p>
                <p className="text-xs text-on-surface-variant">{t('activityLog.logSettingsDesc')}</p>
              </div>
              <Icon name="chevron_right" className="text-secondary" />
            </button>
          </section>
        </div>
      </div>
    </div>
  )
}
