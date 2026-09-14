import { useTranslation } from 'react-i18next'
import Icon from '../primitives/Icon.js'
import Button from '../primitives/Button.js'
import InlineError from '../primitives/InlineError.js'
import { actorInitials, avatarKind, denialReasonKey, metaParts, rowBadge, sentenceKey, sentenceValues, sentinelValues, splitSentence, systemIcon } from '../../auditRow.js'
import type { AuditEntry } from '../../types.js'
import type { emptyStateFor, groupByDay } from '../../auditRow.js'

function timeOf(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function AuditRow({ entry }: { entry: AuditEntry }) {
  const { t, i18n } = useTranslation()
  const badge = rowBadge(entry)
  // The reason trails the row's own context (space, totals): "DENIED" says something was refused,
  // this says what a reader should do about it — nothing, if we simply had no verified identity yet.
  const reasonKey = denialReasonKey(entry)
  const meta = [
    ...metaParts(entry, i18n.language).map((part) => (part.key ? t(part.key, part.values) : part.text)),
    ...(reasonKey ? [t(reasonKey)] : []),
  ].join(' · ')
  const avatar = avatarKind(entry)
  const badgeClasses = badge?.tone === 'error'
    ? 'bg-error-container text-on-error-container'
    : 'bg-surface-container-highest text-on-surface-variant'

  return (
    <li className="px-6 py-4 flex items-start gap-4 hover:bg-surface-container-high/50 transition-colors">
      <span
        aria-hidden="true"
        className="w-8 h-8 rounded-full bg-surface-container-highest text-accent flex items-center justify-center text-xs font-headline font-bold shrink-0"
      >
        {avatar === 'system' ? <Icon name={systemIcon(entry)} size={16} /> : avatar === 'self' ? t('activityLog.actorSelf') : actorInitials(entry)}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          {/* Entity names get weight + accent (the app's in-body emphasis; a fill would collide with
              the status palette). One logical string = one accessible node: the sentence is exposed
              once via sr-only and the visible spans are aria-hidden, so VoiceOver reads it whole. */}
          <p className="text-sm text-on-surface-variant min-w-0">
            <span className="sr-only">{t(sentenceKey(entry), sentenceValues(entry))}</span>
            <span aria-hidden="true">
              {splitSentence(t(sentenceKey(entry), sentinelValues()), sentenceValues(entry)).map((seg, i) => (
                seg.field
                  ? <span key={i} className="font-semibold text-accent">{seg.value}</span>
                  : <span key={i}>{seg.text}</span>
              ))}
            </span>
          </p>
          {badge && (
            <span className={`inline-flex items-center leading-none px-3 pt-[7px] pb-[5px] text-[10px] font-bold rounded-full uppercase tracking-wider border border-outline shrink-0 ${badgeClasses}`}>
              {t(badge.labelKey)}
            </span>
          )}
        </div>
        {meta && <p className="text-xs text-on-surface-variant mt-0.5 truncate">{meta}</p>}
      </div>
      <span className="text-xs text-on-surface-variant tabular-nums shrink-0 pt-0.5">{timeOf(entry.ts)}</span>
    </li>
  )
}

interface ActivityFeedProps {
  groups: ReturnType<typeof groupByDay>
  entries: AuditEntry[]
  loading: boolean
  loadingMore: boolean
  error: string | null
  hasMore: boolean
  loadMore: () => Promise<unknown>
  /** True while any filter narrows the list — the empty state offers a way out only then. */
  active: boolean
  empty: ReturnType<typeof emptyStateFor>
  onClearFilters: () => void
}

/**
 * The event list itself: its count, its empty state, its day groups, and the page after this one.
 */
export default function ActivityFeed(props: ActivityFeedProps) {
  const { t } = useTranslation()
  const { groups, entries, loading, loadingMore, error, hasMore, loadMore, active, empty, onClearFilters } = props
  return (
    <section>
      <div className="flex items-baseline justify-between mb-6">
        <h2 className="text-xl font-headline font-bold text-accent">{t('activityLog.events')}</h2>
        {/* Never "N of M": a filtered total would need a full scan, and the query walks a
            bounded budget, so the honest affordance is a count plus Load more. */}
        <p role="status" aria-live="polite" className="text-xs text-on-surface-variant tabular-nums">
          {loading ? t('activityLog.loading') : t('activityLog.showingCount', { count: entries.length })}
        </p>
      </div>

      {error && <InlineError className="mb-4">{error}</InlineError>}

      {!loading && entries.length === 0 ? (
        <div className="bg-surface-container-low rounded-xl p-10 text-center">
          <div className="w-12 h-12 rounded-full bg-surface-container-high mx-auto flex items-center justify-center text-on-surface-variant mb-4">
            <Icon name={empty.icon} size={22} />
          </div>
          <p className="font-semibold text-accent mb-1">{t(`activityLog.${empty.key}Title`)}</p>
          <p className="text-sm text-on-surface-variant mb-5">{t(`activityLog.${empty.key}Desc`)}</p>
          {active && (
            <Button variant="secondary" onClick={onClearFilters} className="shrink-0">
              {t('activityLog.clearFilters')}
            </Button>
          )}
        </div>
      ) : (
        <div className="bg-surface-container-low rounded-xl overflow-hidden">
          {/* The list is its own scroll region rather than growing the page: a 90-day log
              would otherwise stretch the screen without limit as pages are appended. It
              also makes the day headings pin the way they are meant to — against the list,
              not the page. */}
          {/* `relative`: the scroll-pane rule, see SpaceView's pane. */}
          <div className="relative max-h-[clamp(20rem,52vh,40rem)] overflow-y-auto scrollbar-thin">
            <ul>
              {groups.map((group) => (
                <li key={group.key}>
                  <h3 className="sticky top-0 z-10 bg-surface-container-low px-6 pt-5 pb-2 text-xs font-bold uppercase tracking-wide text-secondary">
                    {group.key === 'today' || group.key === 'yesterday'
                      ? t('activityLog.' + group.key)
                      : new Date(group.entries[0].ts).toLocaleDateString()}
                  </h3>
                  <ul>
                    {group.entries.map((entry) => (
                      <AuditRow key={entry.seq} entry={entry} />
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </div>
          {hasMore && (
            <div className="px-6 py-4 border-t border-outline-variant/40 flex justify-center">
              <Button variant="secondary" onClick={() => { void loadMore() }} disabled={loadingMore} className="shrink-0">
                {loadingMore ? t('activityLog.loading') : t('activityLog.loadMore')}
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
