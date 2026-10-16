import ApprovalModal from './ApprovalModal.js'
import InviteModal from './InviteModal.js'
import LeaveSpaceModal from './LeaveSpaceModal.js'
import EditSpaceModal from './EditSpaceModal.js'
import RemoveFileModal from './RemoveFileModal.js'
import UnshareFilesModal from './UnshareFilesModal.js'
import AddFolderShareModal from './AddFolderShareModal.js'
import DeleteFolderShareModal from './DeleteFolderShareModal.js'
import MirrorFolderModal from './MirrorFolderModal.js'
import { request } from '../../ipc/ipc.js'
import type { FileEntry, JoinRequest, Space, SpaceMember } from '../../types/types.js'
import type { ShareWithRole } from '../../hooks/useShares.js'

// The dialogs this screen can show, one at a time by construction. They were eight independent
// pieces of state and nothing held them apart: an action arriving from another screen could raise a
// second dialog behind the one already up. Each carries exactly what it needs to open.
export type SpaceDialog =
  | { kind: 'invite' }
  | { kind: 'approval' }
  | { kind: 'leave' }
  | { kind: 'edit' }
  | { kind: 'remove-file'; file: FileEntry }
  | { kind: 'unshare-files'; files: FileEntry[] }
  | { kind: 'add-folder'; path: string }
  | { kind: 'delete-share'; share: ShareWithRole }
  | { kind: 'mirror-share'; share: ShareWithRole }

const NO_FILES: FileEntry[] = []

interface FileDialogsProps {
  dialog: SpaceDialog | null
  spaceId: string
  onClose: () => void
  onRemoveFile: () => Promise<void>
  onUnsharedFiles: () => void
}

// The two dialogs about loose files: one file's removal, and a selection's.
function FileDialogs({ dialog, spaceId, onClose, onRemoveFile, onUnsharedFiles }: FileDialogsProps) {
  return (
    <>
      <RemoveFileModal
        isOpen={dialog?.kind === 'remove-file'}
        filePath={dialog?.kind === 'remove-file' ? dialog.file.path : ''}
        onClose={onClose}
        onRemove={onRemoveFile}
      />
      <UnshareFilesModal
        isOpen={dialog?.kind === 'unshare-files'}
        spaceId={spaceId}
        files={dialog?.kind === 'unshare-files' ? dialog.files : NO_FILES}
        onClose={onClose}
        onDone={() => { onClose(); onUnsharedFiles() }}
      />
    </>
  )
}

// Every dialog the space screen can show, in one place: which one is on screen is the `dialog`
// union's job, and this reads it. It lives apart from the screen because the screen's own body is
// about the content behind them.
export default function SpaceDialogs({
  dialog, onClose, space, spaceId, spaceName, requests, busyKeys, members, existingShareNames,
  onApproveMany, onDeny, onCreateInvite, onSaveSpace, onLeave, onLeft, onRemoveFile, onUnsharedFiles,
}: {
  dialog: SpaceDialog | null
  onClose: () => void
  space: Space | undefined
  spaceId: string
  spaceName: string
  requests: JoinRequest[]
  busyKeys: Set<string>
  members: SpaceMember[]
  existingShareNames: string[]
  onApproveMany: (keys: string[]) => void
  onDeny: (publicKey: string) => void
  onCreateInvite: (opts: { autoApprove: boolean; expiresInMs: number }) => Promise<string>
  onSaveSpace: (spaceId: string, name: string, icon: string, downloadFolder?: string) => Promise<Space>
  onLeave: () => Promise<void>
  onLeft: () => void
  onRemoveFile: () => Promise<void>
  onUnsharedFiles: () => void
}) {
  return (
    <>
      <ApprovalModal
        isOpen={dialog?.kind === 'approval'}
        requests={requests}
        busyKeys={busyKeys}
        onApproveMany={onApproveMany}
        onDeny={onDeny}
        onClose={onClose}
      />
      <InviteModal
        isOpen={dialog?.kind === 'invite'}
        onCreate={onCreateInvite}
        onClose={onClose}
      />
      <LeaveSpaceModal
        isOpen={dialog?.kind === 'leave'}
        spaceName={spaceName}
        onClose={onClose}
        onLeave={onLeave}
        onComplete={onLeft}
      />
      {space && dialog?.kind === 'edit' && (
        <EditSpaceModal
          space={space}
          onSave={onSaveSpace}
          onClose={onClose}
        />
      )}
      <FileDialogs dialog={dialog} spaceId={spaceId} onClose={onClose} onRemoveFile={onRemoveFile} onUnsharedFiles={onUnsharedFiles} />
      <AddFolderShareModal
        isOpen={dialog?.kind === 'add-folder'}
        spaceId={spaceId}
        spaceName={spaceName}
        existingShareNames={existingShareNames}
        initialMountPath={dialog?.kind === 'add-folder' ? dialog.path : ''}
        onClose={onClose}
        onCreated={onClose}
      />
      <DeleteFolderShareModal
        isOpen={dialog?.kind === 'delete-share'}
        folderName={dialog?.kind === 'delete-share' ? dialog.share.name : ''}
        spaceName={spaceName}
        onClose={onClose}
        onDelete={async () => {
          if (dialog?.kind !== 'delete-share') return
          await request('owned-folder:delete', { spaceId, shareId: dialog.share.id })
          onClose()
        }}
      />
      {dialog?.kind === 'mirror-share' && (
        <MirrorFolderModal
          isOpen
          share={dialog.share}
          owner={members.find((m) => m.publicKey === dialog.share.owner) ?? null}
          onClose={onClose}
          onMounted={onClose}
        />
      )}
    </>
  )
}
