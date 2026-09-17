import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useHasVerticalOverflow } from '../hooks/useHasVerticalOverflow.js'
import { useActivityFilters } from '../hooks/useActivityFilters.js'
import { useAuditLog } from '../hooks/useAuditLog.js'
import { groupByDay } from '../model/audit-row.js'
import type { AuditFilters } from '../types/types.js'
import ActivityFilterBar from '../components/activity/ActivityFilterBar.js'
import ActivityFeed from '../components/activity/ActivityFeed.js'
import PageHeader from '../components/layout/PageHeader.js'
import ActionRow, { ROW_GROUP } from '../components/layout/ActionRow.js'
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
            <div className={ROW_GROUP}>
              <ActionRow
                icon="tune"
                label={t('activityLog.logSettings')}
                desc={t('activityLog.logSettingsDesc')}
                onClick={onOpenSettings}
              />
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
