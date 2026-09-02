// Who owns this folder and who mirrors it — read, never pressed. The mirror list is the durable
// participation record, so it survives a peer being offline, and it is available to every role:
// listMirrorsForShare merges our own record with every member's.
import { memo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Avatar from '../primitives/Avatar.js'
import CollapsibleCard from '../primitives/CollapsibleCard.js'
import TextButton from '../primitives/TextButton.js'
import { useSpaceMirrors } from '../../hooks/useSpaceMirrors.js'
import { useSpaceCardState } from '../../hooks/useSpaceCardState.js'
import type { MirrorParticipant, Profile, SpaceMember } from '../../types.js'

const STACK_MAX = 5

type MirrorState = MirrorParticipant['state']

interface Mirrorer {
  key: string
  name: string
  avatar: string | null
  state: MirrorState
  online: boolean
}

interface FolderPeopleCardProps {
  spaceId: string
  shareId: string
  members: SpaceMember[]
  owner: SpaceMember | null
  isYou: boolean
  selfProfile: Profile | null
  selfPublicKey: string
}

// The avatar ring encodes the peer's sync state: green when fully merged, amber when paused, and a
// blue ring that pulses while the peer is online and actively pulling (static blue when offline
// mid-sync). Colour, never opacity.
function ringClass(state: MirrorState, online: boolean): string {
  if (state === 'paused') return 'avatar-ring-paused'
  if (state === 'syncing') return online ? 'avatar-ring-syncing-active' : 'avatar-ring-syncing'
  return 'avatar-ring-synced'
}

function MirrorRow({ mirrorer, stateLabel }: { mirrorer: Mirrorer; stateLabel: string }) {
  return (
    <div className="flex items-center gap-3">
      <Avatar src={mirrorer.avatar} displayName={mirrorer.name} size="md" className={ringClass(mirrorer.state, mirrorer.online)} decorative />
      <div className="min-w-0 flex-1">
        <p className="font-bold text-accent text-sm truncate">{mirrorer.name}</p>
        <p className="text-xs text-on-surface-variant">{stateLabel}</p>
      </div>
    </div>
  )
}

function MirrorStack({ mirrorers, label }: { mirrorers: Mirrorer[]; label: string }) {
  const stack = mirrorers.slice(0, STACK_MAX)
  const overflow = mirrorers.length - stack.length
  return (
    <div role="img" aria-label={label} className="flex items-center">
      {stack.map((m, i) => (
        <span key={m.key} className={i === 0 ? '' : '-ml-3'}>
          <Avatar src={m.avatar} displayName={m.name} size="md" className={ringClass(m.state, m.online)} decorative />
        </span>
      ))}
      {overflow > 0 && (
        <span
          style={{ boxShadow: '0 0 0 2px var(--color-surface-container-low)' }}
          className="-ml-3 w-9 h-9 rounded-full bg-surface-container-highest text-on-surface-variant flex items-center justify-center font-bold text-sm"
        >
          <span aria-hidden="true">+{overflow}</span>
        </span>
      )}
    </div>
  )
}

function OwnerRow({ name, avatar, online, isYou, spaced }: { name: string; avatar: string | null; online: boolean; isYou: boolean; spaced: boolean }) {
  const { t } = useTranslation()
  return (
    <div className={`flex items-center gap-3${spaced ? ' mb-6' : ''}`}>
      <div className="relative shrink-0">
        <Avatar src={avatar} displayName={name} size="lg" decorative />
        <div
          aria-hidden="true"
          className={`absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-surface-container-low ${online ? 'bg-online' : 'bg-offline'}`}
        />
      </div>
      <div className="min-w-0">
        <p className={`font-bold truncate ${online ? 'text-accent' : 'text-outline'}`}>{isYou ? t('member.you') : name}</p>
        {!isYou && <p className="text-xs text-on-surface-variant">{online ? t('member.online') : t('member.offline')}</p>}
      </div>
    </div>
  )
}

function FolderPeopleCard({
  spaceId,
  shareId,
  members,
  owner,
  isYou,
  selfProfile,
  selfPublicKey,
}: FolderPeopleCardProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useSpaceCardState(spaceId, 'folderPeopleOpen')
  const [expanded, setExpanded] = useState(false)
  const mirrors = useSpaceMirrors(spaceId, shareId)

  const stateLabel = (state: MirrorState) =>
    t(state === 'paused' ? 'folder.mirrorStatePaused' : state === 'syncing' ? 'folder.mirrorStateSyncing' : 'folder.mirrorStateSynced')

  const resolved: Mirrorer[] = mirrors.map((m) => {
    const isSelf = m.mirrorer === selfPublicKey
    const member = members.find((x) => x.publicKey === m.mirrorer) ?? null
    return {
      key: m.mirrorer,
      name: isSelf ? t('member.you') : (member?.displayName || t('avatar.unknown')),
      avatar: (isSelf ? selfProfile?.avatar : member?.avatar) ?? null,
      state: m.state,
      online: isSelf || member?.online !== false,
    }
  })

  // The ring colour alone can't distinguish synced (green) from paused (amber) for a colour-blind
  // viewer, so the stack pairs the facepile with a per-state count in text.
  const counts: Record<MirrorState, number> = { synced: 0, syncing: 0, paused: 0 }
  for (const r of resolved) counts[r.state] += 1
  const summary = (['syncing', 'paused', 'synced'] as MirrorState[])
    .filter((s) => counts[s] > 0)
    .map((s) => `${counts[s]} ${stateLabel(s)}`)
    .join(' · ')
  const namesLabel = t('folder.mirroredByNames', { names: resolved.map((r) => `${r.name} — ${stateLabel(r.state)}`).join(', ') })
  const asList = expanded || resolved.length === 1

  // The owner is a person too, so the header count is the whole tile: owner + everyone mirroring.
  // Guarded against an owner who also appears in the mirror list rather than assuming they can't.
  const ownerKey = isYou ? selfPublicKey : (owner?.publicKey ?? '')
  const peopleCount = 1 + resolved.filter((r) => r.key !== ownerKey).length

  return (
    <CollapsibleCard
      icon="group"
      title={t('folder.peopleHeading')}
      count={peopleCount}
      open={open}
      onOpenChange={setOpen}
    >
      <p className="text-xs font-bold uppercase tracking-wide text-secondary mb-3">{t('folder.ownerEyebrow')}</p>
      <OwnerRow
        name={isYou ? (selfProfile?.displayName || t('avatar.unknown')) : (owner?.displayName || t('avatar.unknown'))}
        avatar={(isYou ? selfProfile?.avatar : owner?.avatar) ?? null}
        online={isYou || owner?.online !== false}
        isYou={isYou}
        spaced={resolved.length > 0}
      />

      {/* No empty state: a folder nobody mirrors simply has no such section. */}
      {resolved.length > 0 && (
        <>
          <p className="text-xs font-bold uppercase tracking-wide text-secondary mb-3">
            {t('folder.mirroringEyebrow', { count: resolved.length })}
          </p>
          {asList ? (
            <div className="space-y-3">
              {resolved.map((m) => <MirrorRow key={m.key} mirrorer={m} stateLabel={stateLabel(m.state)} />)}
            </div>
          ) : (
            <MirrorStack mirrorers={resolved} label={namesLabel} />
          )}
          {/* The per-state counts and the toggle share one baseline row, so the toggle sits at the
              card's right edge in both states — the same place the Members tile puts it. Stacked at
              the left it landed in the eyebrows' column wearing the eyebrows' colour and weight,
              and read as a third heading rather than as the one thing here you can press. */}
          {resolved.length > 1 && (
            <div className="mt-3 flex items-baseline justify-between gap-3">
              <p className="text-xs text-on-surface-variant">{summary}</p>
              <TextButton onClick={() => setExpanded((v) => !v)} ariaExpanded={expanded}>
                {expanded ? t('space.showFewerMembers') : t('space.showAllMembers')}
              </TextButton>
            </div>
          )}
        </>
      )}
    </CollapsibleCard>
  )
}

// FolderView re-renders on every progress tick; these tiles change only when the folder does.
export default memo(FolderPeopleCard)
