// One of this device's files that members are fetching: its row as the owner sees it in the space,
// with who is downloading and Reveal in Folder.
import { memo, useCallback, useMemo } from 'react'
import { request } from '../../ipc/ipc.js'
import { useRunAction } from '../../hooks/useRunAction.js'
import { revealOnClient } from '../../platform/reveal-client.js'
import { fileName } from '../../format/utils.js'
import { FILE_STATUS } from '../../../shared/contract/statuses.js'
import { LOOSE_SHARE_ID } from '../../../shared/contract/entry-ref.js'
import type { ShareFileRow, SpaceMember, PeerDownloadSummary, FileRecipient } from '../../types/types.js'
import type { TransferServing } from '../../../shared/contract/responses.js'
import FileRow from '../cards/FileRow.js'

interface TransferServingRowProps {
  serving: TransferServing
  selfKey: string
  members: SpaceMember[]
  downloadSummary: PeerDownloadSummary | null
}

const NO_RECIPIENTS: FileRecipient[] = []
// Nothing is fetched for a file this device owns.
const unoffered = () => {}

function TransferServingRow({ serving, selfKey, members, downloadSummary }: TransferServingRowProps) {
  const run = useRunAction()
  const { spaceId, shareId, path, size } = serving
  // The row is keyed by the path the serve is announced under, which is also what the list of
  // downloaders subscribes by: '/'-rooted for a loose file, the path in its folder otherwise.
  const file: ShareFileRow = useMemo(
    () => ({ relPath: path, size, hash: '', mtime: 0, status: FILE_STATUS.SYNCED, localPath: null }),
    [path, size],
  )
  const reveal = useCallback(
    (relPath: string) => run(async () => revealOnClient(shareId === LOOSE_SHARE_ID
      ? await request('files:reveal', { spaceId, path: relPath })
      : await request('share:reveal-file', { spaceId, ownerKey: selfKey, shareId, relPath }))),
    [run, spaceId, shareId, selfKey],
  )
  return (
    <FileRow
      kind="share"
      file={file}
      displayName={fileName(path)}
      manualControls
      flat
      ownerKey={selfKey}
      isOwn
      decoration={null}
      seeded={false}
      spaceId={spaceId}
      members={members}
      downloadSummary={downloadSummary}
      recipients={NO_RECIPIENTS}
      onPause={unoffered}
      onCancel={unoffered}
      onDownload={unoffered}
      onReveal={reveal}
    />
  )
}

export default memo(TransferServingRow)
