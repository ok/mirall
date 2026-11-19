// One download on the transfers page: the file row its own listing shows, with the verbs bound to
// the space and folder it belongs to.
import { memo, useCallback } from 'react'
import { request } from '../../ipc/ipc.js'
import { useRunAction } from '../../hooks/useRunAction.js'
import type { FileEntry, SpaceMember, FileRecipient } from '../../types/types.js'
import type { Decoration } from '../../types/ui.js'
import type { TransferDownload } from '../../../shared/contract/responses.js'
import FileRow from '../cards/FileRow.js'

interface TransferDownloadRowProps {
  spaceId: string
  download: TransferDownload
  decoration: Decoration | null
  members: SpaceMember[]
  onPause: (transferId: string) => void
  onCancel: (transferId: string) => void
}

const NO_RECIPIENTS: FileRecipient[] = []
// A download that is under way is never offered Reveal, Unshare or a publish cancel.
const unoffered = () => {}

function TransferDownloadRow({ spaceId, download, decoration, members, onPause, onCancel }: TransferDownloadRowProps) {
  const run = useRunAction()
  const { shareId, ownerKey } = download
  // Resume and Retry name no folder: the download keeps the one it was going to.
  const resumeLoose = useCallback(
    (file: FileEntry) => run(() => request('files:download', { spaceId, path: file.path, ownerKey: file.owner.publicKey }), 'transferFailed'),
    [run, spaceId],
  )
  const resumeInFolder = useCallback(
    (relPath: string) => run(() => request('share:read-file', { spaceId, ownerKey, shareId, relPath })),
    [run, spaceId, ownerKey, shareId],
  )
  const shared = { decoration, seeded: false, isOwn: false, spaceId, members, downloadSummary: null, recipients: NO_RECIPIENTS, onPause, onCancel }
  if (download.kind === 'loose') {
    return <FileRow kind="loose" file={download.file} onDownload={resumeLoose} onReveal={unoffered} onUnshare={unoffered} onCancelPublish={unoffered} {...shared} />
  }
  return (
    <FileRow
      kind="share"
      file={download.file}
      displayName={`${download.folder}/${download.file.relPath}`}
      manualControls
      flat
      ownerKey={ownerKey}
      onDownload={resumeInFolder}
      onReveal={unoffered}
      {...shared}
    />
  )
}

export default memo(TransferDownloadRow)
