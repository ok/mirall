// Home screen: the user's spaces as cards, with create/join entry points. Per-space
// actions (edit, favorite) live in the space's own header menu, not on the cards.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSpaces } from '../hooks/useSpaces.js'
import { useHasVerticalOverflow } from '../hooks/useHasVerticalOverflow.js'
import SpaceCard from '../components/cards/SpaceCard.js'
import Button from '../components/primitives/Button.js'
import DocsCard from '../components/cards/DocsCard.js'
import BackupPromptCard from '../components/backup/BackupPromptCard.js'
import { useRestoreHold } from '../hooks/useRestoreHold.js'
import { useHeldControl } from '../hooks/useHeldControl.js'
import { inHeldOrder } from '../model/held-order.js'
import { shortcutOrder } from '../model/space-shortcut-order.js'
import { spaceDigitAccelerator } from '../keyboard/known-commands.js'

const LABEL_REFRESH_MS = 60000

interface YourSpacesProps {
  onSelectSpace: (spaceId: string) => void
  onShowCreate: () => void
  onShowJoin: () => void
}

export default function YourSpaces({ onSelectSpace, onShowCreate, onShowJoin }: YourSpacesProps) {
  const { t } = useTranslation()
  const createControl = useHeldControl(!useRestoreHold().canWriteProfile)
  const { spaces, loading } = useSpaces()
  const [filter, setFilter] = useState<'all' | 'favorites'>('all')
  const { ref: listRef, hasOverflow } = useHasVerticalOverflow<HTMLDivElement>()

  // The cards say how long ago each space was active, so the clock they read moves on its own.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), LABEL_REFRESH_MS)
    return () => clearInterval(timer)
  }, [])

  // spaces:list arrives most recently active first. While the pointer is over the list or focus is
  // in it, the order it had then is held, so a click or Tab never lands on a card that moved.
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [heldIds, setHeldIds] = useState<string[] | null>(null)
  const holding = hovered || focused
  if (holding && !heldIds) setHeldIds(spaces.map((s) => s.spaceId))
  if (!holding && heldIds) setHeldIds(null)
  const ordered = inHeldOrder(spaces, heldIds)
  const filteredSpaces = filter === 'favorites'
    ? ordered.filter(s => s.favorite)
    : ordered
  const shortcuts = new Map(shortcutOrder(spaces).map((s, i) => [s.spaceId, spaceDigitAccelerator(i)]))

  return (
    <div className="max-w-(--breakpoint-2xl) mx-auto px-8 flex flex-col h-[calc(100vh-5rem-var(--banner-h,0px))] pb-8">
      <div className="pt-8 pb-4 shrink-0">
        <h1 className="text-5xl md:text-6xl font-headline font-extrabold text-accent tracking-tight leading-tight mb-4">
          {t('spaces.title')}{' '}
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-accent to-secondary">
            {t('spaces.titleEmphasis')}
          </span>
        </h1>
        <p className="text-on-surface-variant text-lg max-w-2xl leading-relaxed">
          {t('spaces.intro')}
        </p>

        <div className="flex items-center gap-3 mt-6 mb-4">
          {(['all', 'favorites'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              aria-pressed={filter === f}
              className={`px-6 py-2.5 rounded-full font-medium transition-all active:scale-95 focus-ring ${
                filter === f
                  ? 'bg-primary text-on-primary shadow-lg shadow-primary/10 hover:bg-primary-hover'
                  : 'bg-surface-control text-on-surface-variant hover:bg-surface-control-hover'
              }`}
            >
              {f === 'all' ? t('spaces.tabAll') : t('spaces.tabFavorites')}
            </button>
          ))}
          <div className="flex-1" />
          <Button icon="add_circle" onClick={createControl.guard(onShowCreate)} {...createControl.attrs}>
            {t('spaces.create')}
          </Button>
          <Button icon="group_add" onClick={onShowJoin}>
            {t('spaces.join')}
          </Button>
        </div>
      </div>

      <BackupPromptCard />

      <div
        ref={listRef}
        role={filteredSpaces.length > 0 ? 'list' : undefined}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false) }}
        className={`flex-1 overflow-y-auto space-y-4 pb-4 scrollbar-thin${hasOverflow ? ' pr-4' : ''}`}
      >
        {/* Gated on `loading`: an unsettled list has no spaces YET, which is not the same
            fact as an account with none — see spaceContentState.js. */}
        {!loading && filteredSpaces.length === 0 && filter === 'all' && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <h2 className="text-2xl font-headline font-bold text-accent mb-3">{t('spaces.emptyNoSpaces')}</h2>
            <p className="text-on-surface-variant max-w-md leading-relaxed">{t('spaces.emptyNoSpacesHint')}</p>
            <DocsCard
              icon="school"
              title={t('spaces.emptyDocsTitle')}
              body={t('spaces.emptyDocsBody')}
              className="w-full max-w-md mt-8"
              links={[
                { target: { page: 'tutorials', anchor: 'send-your-first-files' }, label: t('docs.sendFirstFiles') },
                { target: { page: 'guides', anchor: 'create-a-space' }, label: t('docs.createSpace') },
                { target: { page: 'guides', anchor: 'join-a-space' }, label: t('docs.joinSpace') },
              ]}
            />
          </div>
        )}
        {!loading && filteredSpaces.length === 0 && filter === 'favorites' && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <h2 className="text-2xl font-headline font-bold text-accent mb-3">{t('spaces.emptyNoFavorites')}</h2>
            <p className="text-on-surface-variant max-w-md leading-relaxed">{t('spaces.emptyNoFavoritesHint')}</p>
          </div>
        )}
        {filteredSpaces.map((space) => (
          <div role="listitem" key={space.spaceId}>
            <SpaceCard
              space={space}
              now={now}
              shortcut={shortcuts.get(space.spaceId)}
              onClick={() => onSelectSpace(space.spaceId)}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
