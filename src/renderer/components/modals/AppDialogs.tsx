import FeedbackModal from './FeedbackModal.js'
import WhatsNewModal from './WhatsNewModal.js'
import CreateSpaceModal from './CreateSpaceModal.js'
import JoinSpaceModal from './JoinSpaceModal.js'
import type { Space } from '../../types/types.js'

// The dialogs the shell can show, one at a time by construction: a deep link arriving while
// feedback is open replaces it rather than stacking behind it, and hiding to the tray clears
// whichever is up. The join dialog carries the prefill a deep link supplies.
export type AppDialog =
  | { kind: 'feedback' }
  | { kind: 'create' }
  | { kind: 'join'; code?: string; name?: string }

interface AppDialogsProps {
  dialog: AppDialog | null
  onClose: () => void
  onCreate: (name: string, icon: string) => Promise<Space>
  onJoin: (inviteCode: string, name: string) => Promise<Space>
  onEntered: (spaceId: string) => void
}

export default function AppDialogs({ dialog, onClose, onCreate, onJoin, onEntered }: AppDialogsProps) {
  const join = dialog?.kind === 'join' ? dialog : null
  return (
    <>
      <FeedbackModal isOpen={dialog?.kind === 'feedback'} onClose={onClose} />
      <WhatsNewModal />
      <CreateSpaceModal
        isOpen={dialog?.kind === 'create'}
        onClose={onClose}
        onCreate={onCreate}
        onCreated={(space) => onEntered(space.spaceId)}
      />
      <JoinSpaceModal
        isOpen={join !== null}
        initialCode={join?.code}
        initialName={join?.name}
        onClose={onClose}
        onJoin={onJoin}
        onJoined={(space) => onEntered(space.spaceId)}
      />
    </>
  )
}
