import { useTranslation } from 'react-i18next'
import Avatar from '../primitives/Avatar.js'
import Icon from '../primitives/Icon.js'
import { useSpaceMirrors } from '../../hooks/useSpaceMirrors.js'
import type { MirrorParticipant, SpaceMember } from '../../types.js'

const STACK_MAX = 5

type MirrorState = MirrorParticipant['state']

interface MirroredByWidgetProps {
  spaceId: string
  shareId: string
  members: SpaceMember[]
}

// The avatar ring encodes the peer's sync state: green when fully merged, amber when paused, and a
// blue ring that pulses while the peer is online and actively pulling (static blue when offline
// mid-sync). Colour, never opacity.
function ringClass(state: MirrorState, online: boolean): string {
  if (state === 'paused') return 'avatar-ring-paused'
  if (state === 'syncing') return online ? 'avatar-ring-syncing-active' : 'avatar-ring-syncing'
  return 'avatar-ring-synced'
}

// Sidebar widget on the owner's folder screen, between the "shared by" and folder-size cards: the
// peers mirroring this folder, from the durable participation records. A lone mirror shows its name
// and state; several stack into an overlapping facepile. Strictly additive — renders nothing until
// someone mirrors the folder.
export default function MirroredByWidget({ spaceId, shareId, members }: MirroredByWidgetProps) {
  const { t } = useTranslation()
  const mirrors = useSpaceMirrors(spaceId, shareId)
  if (mirrors.length === 0) return null

  const nameOf = (member: SpaceMember | null) => member?.displayName ?? t('avatar.unknown')
  const stateLabel = (state: MirrorState) =>
    t(state === 'paused' ? 'folder.mirrorStatePaused' : state === 'syncing' ? 'folder.mirrorStateSyncing' : 'folder.mirrorStateSynced')

  const resolved = mirrors.map((m) => {
    const member = members.find((x) => x.publicKey === m.mirrorer) ?? null
    return { key: m.mirrorer, member, state: m.state, online: member?.online !== false }
  })
  const stack = resolved.slice(0, STACK_MAX)
  const overflow = resolved.length - stack.length

  // The ring colour alone can't distinguish synced (green) from paused (amber) for a colour-blind
  // viewer, so the stack pairs the facepile with a per-state count in text.
  const counts: Record<MirrorState, number> = { synced: 0, syncing: 0, paused: 0 }
  for (const r of resolved) counts[r.state] += 1
  const summary = (['syncing', 'paused', 'synced'] as MirrorState[])
    .filter((s) => counts[s] > 0)
    .map((s) => `${counts[s]} ${stateLabel(s)}`)
    .join(' · ')

  return (
    <div className="bg-surface-container-low p-8 rounded-2xl">
      <h3 className="text-xl font-headline font-bold text-accent mb-6 flex items-center gap-2">
        <Icon name="folder_download" className="text-secondary" />
        {t('folder.mirroredByHeading')}
      </h3>
      {resolved.length === 1 ? (
        <div className="flex items-center gap-3">
          <Avatar
            src={resolved[0].member?.avatar}
            displayName={resolved[0].member?.displayName}
            size="md"
            className={ringClass(resolved[0].state, resolved[0].online)}
            decorative
          />
          <div className="min-w-0">
            <p className="font-bold text-accent truncate">{nameOf(resolved[0].member)}</p>
            <p className="text-xs text-on-surface-variant">{stateLabel(resolved[0].state)}</p>
          </div>
        </div>
      ) : (
        <div>
          <div
            role="img"
            aria-label={t('folder.mirroredByNames', { names: resolved.map((r) => `${nameOf(r.member)} — ${stateLabel(r.state)}`).join(', ') })}
            className="flex items-center"
          >
            {stack.map((d, i) => (
              <span key={d.key} className={i === 0 ? '' : '-ml-3'}>
                <Avatar src={d.member?.avatar} displayName={d.member?.displayName} size="md" className={ringClass(d.state, d.online)} decorative />
              </span>
            ))}
            {overflow > 0 && (
              <span
                style={{ boxShadow: '0 0 0 2px var(--color-surface-container-low)' }}
                className="-ml-3 w-9 h-9 rounded-full bg-surface-container-highest text-on-surface-variant flex items-center justify-center font-bold text-sm"
              >
                +{overflow}
              </span>
            )}
          </div>
          <p className="text-xs text-on-surface-variant mt-3">{summary}</p>
        </div>
      )}
    </div>
  )
}
