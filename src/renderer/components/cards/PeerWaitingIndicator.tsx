import { useTranslation } from 'react-i18next'
import type { SpaceMember } from '../../types/types.js'
import type { PersonKey } from '../../../shared/contract/principals.js'
import { PEER_STACK_MAX, peerFaces, peerStackAvatar } from '../../model/member-summary.js'
import AvatarStack from '../primitives/AvatarStack.js'
import Icon from '../primitives/Icon.js'

interface PeerWaitingIndicatorProps {
  waiterKeys: PersonKey[]
  members: SpaceMember[]
  open: boolean
  onToggle: () => void
  controlsId: string
}

// Who is waiting on a file we are still hashing, beside our own hash bar. The stack names the
// people; the count is the toggle for the per-peer dropdown and is named by its visible text, so
// each reads on its own. It yields width before the hash bar does: the count truncates to its floor,
// and a narrow row sheds the stack — the dropdown still names everyone.
export default function PeerWaitingIndicator({ waiterKeys, members, open, onToggle, controlsId }: PeerWaitingIndicatorProps) {
  const { t } = useTranslation()
  const waiters = peerFaces(waiterKeys, members)
  const names = waiters.map((w) => w.member?.displayName || t('member.unknown')).join(', ')
  return (
    <div className="ml-4 shrink min-w-[72px] self-center flex items-center justify-end gap-2">
      {/* The row lifts under the cursor, so the rings follow it to the hover surface. */}
      <AvatarStack
        className="shrink-0 hidden @min-[440px]/row:flex group-hover:[--avatar-ring:var(--color-surface-container-highest)]"
        size="sm"
        surface="surface-container-lowest"
        announce="group"
        label={t('file.waitingFor', { names })}
        max={PEER_STACK_MAX}
        avatars={waiters.map((w) => peerStackAvatar(w))}
      />
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={open ? controlsId : undefined}
        className="min-w-0 flex items-center gap-0.5 rounded-lg py-1 pl-1.5 pr-0.5 text-[11px] leading-none text-on-surface-variant hover:bg-surface-container-high focus-ring"
      >
        <span className="truncate">{t('file.waitingCount', { count: waiters.length })}</span>
        <Icon
          name="chevron_right"
          size={18}
          className={`text-secondary shrink-0 transition-transform duration-200 motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}
        />
      </button>
    </div>
  )
}
