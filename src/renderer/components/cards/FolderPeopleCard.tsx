// Who owns this folder and who mirrors it — read, never pressed. The mirror list is the durable
// participation record, so it survives a peer being offline, and it is available to every role:
// listMirrorsForShare merges our own record with every member's.
import { memo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Avatar from '../primitives/Avatar.js'
import Icon from '../primitives/Icon.js'
import { useSpaceMirrors } from '../../hooks/useSpaceMirrors.js'
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
  roleDescription: string
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
  roleDescription,
}: FolderPeopleCardProps) {
  const { t } = useTranslation()
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

  return (
    <div className="bg-surface-container-low rounded-2xl p-8">
      <h3 className="text-xl font-headline font-bold text-accent mb-6 flex items-center gap-2">
        <Icon name="group" className="text-secondary" />
        {t('folder.peopleHeading')}
      </h3>

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
          {resolved.length > 1 && (
            <>
              <p className="text-xs text-on-surface-variant mt-3">{summary}</p>
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                aria-expanded={expanded}
                className="mt-3 text-secondary font-bold text-sm rounded hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30"
              >
                {expanded ? t('space.showFewerMembers') : t('space.showAllMembers')}
              </button>
            </>
          )}
        </>
      )}

      {/* What this role means, in readable text. It used to live here as body copy; a title on a
          16px glyph is not a substitute — there is nothing to hover on a touch screen and nothing
          to activate with a keyboard. */}
      <p className="text-xs text-on-surface-variant leading-relaxed mt-6">{roleDescription}</p>
    </div>
  )
}

// FolderView re-renders on every progress tick; these tiles change only when the folder does.
export default memo(FolderPeopleCard)
