// Storage settings: the download-folder picker and App Storage.
import InlineError from '../../components/primitives/InlineError.js'
import { useState, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { request } from '../../ipc/ipc.js'
import { useHasVerticalOverflow } from '../../hooks/useHasVerticalOverflow.js'
import { useQuery } from '../../store/useQuery.js'
import { useMainQuery } from '../../store/useMainQuery.js'
import { useDownloadRootStatus } from '../../hooks/useDownloadRootStatus.js'
import AppStorageCard from '../../components/storage/AppStorageCard.js'
import { useRunAction } from '../../hooks/useRunAction.js'
import PathRow from '../../components/path/PathRow.js'
import PageHeader from '../../components/layout/PageHeader.js'
import SectionHeading from '../../components/layout/SectionHeading.js'
import { useErrorText } from '../../hooks/useErrorText.js'

// Module-level so the entry's scope list is one array, not a fresh literal per render.
const STORAGE_SCOPES = [{ kind: 'files' }, { kind: 'shares' }, { kind: 'share-files' }, { kind: 'storage' }]

interface StorageSettingsProps {
  onBack: () => void
  onOpenActivityLogSettings: () => void
  onLeftSpace: (spaceId: string) => void
}

// Trailing separators and Unicode composition are the two ways the same folder reaches us
// spelled differently; neither changes which folder it is.
function samePath(a: string, b: string) {
  const strip = (p: string) => p.replace(/[/\\]+$/, '').normalize('NFC')
  return strip(a) === strip(b)
}

export default function StorageSettings({ onBack, onOpenActivityLogSettings, onLeftSpace }: StorageSettingsProps) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const runAction = useRunAction()
  const [folderError, setFolderError] = useState<string | null>(null)
  const { unavailable: unavailableRoots, refresh: refreshRootStatus } = useDownloadRootStatus()

  // storage:info is a cross-space disk aggregate, so it watches the file, share and share-file
  // scopes without pinning a spaceId — a hint for any space matches (scopeMatches only compares an
  // id the VIEW pins) — and the storage scope a finished measurement pokes. The coalesce window
  // matters here: an owned-folder scan pokes files-updated in bursts, and this read walks the store.
  const { data: info, loading } = useQuery('storage:info', {}, STORAGE_SCOPES, { coalesceMs: 750 })

  // The categories are measured on a schedule; opening the screen measures them now, and the
  // measurement's poke replaces the stored one on screen. It waits on any compaction in flight, so it
  // has no deadline of its own.
  useEffect(() => {
    runAction(() => request('storage:measure', {}, 0))
  }, [runAction])

  const { data: folderData, error: folderReadError, write: writeDownloadFolder } = useMainQuery('main:download-folder')
  // null until the read lands: the field says it is loading rather than offering a first pick for
  // a folder that always exists. A read that FAILED is a known-empty folder instead, so the row
  // drops out of the loading state and offers the pick that would fix it.
  const downloadFolder = folderData ?? (folderReadError ? '' : null)
  const shownError = folderError ?? (folderReadError ? errorText(folderReadError) : null)

  const handleBrowseFolder = useCallback(async () => {
    setFolderError(null)
    try {
      const picked = await window.bridge.browseDownloadFolder()
      if (!picked) return
      // The WORKER validates first: only it can see the owned/mirrored folders a download
      // root must not overlap. Persisting in main first would leave a rejected folder in the
      // config, and the next launch would spawn the worker on it with nothing left to check it.
      await request('settings:set-download-folder', { folder: picked })
      // Through the store, not into local state: the Edit Space modal reads the same fact for its
      // global-default fallback and would otherwise keep a copy that disagrees until it remounts.
      await writeDownloadFolder(picked)
      // The picker only accepts a folder that validated, so the warning below is stale the
      // moment this resolves — re-probe rather than leaving it up until the next 60s tick.
      await refreshRootStatus()
    } catch (err) {
      setFolderError(errorText(err))
    }
  }, [refreshRootStatus, errorText, writeDownloadFolder])

  // This screen shows the GLOBAL root; `unavailableRoots` also carries per-space overrides, so
  // match rather than test for a non-empty list. The two strings reach us by different routes —
  // main stores the path the picker returned, the worker stores its own resolved + NFC-normalized
  // copy — so compare them normalized instead of raw, or a folder with an umlaut in its name
  // silently fails to match and the warning never shows.
  // Not yet read is not "unavailable": the warning stays down until there is a folder to test.
  const knownFolder = downloadFolder ?? ''
  const folderUnavailable = knownFolder.length > 0
    && unavailableRoots.some((root) => samePath(root, knownFolder))

  const { ref, hasOverflow } = useHasVerticalOverflow<HTMLDivElement>()

  return (
    <div
      ref={ref}
      className={`relative h-[calc(100vh-5.5rem-var(--banner-h,0px))] overflow-y-auto scrollbar-thin pb-8 mr-2 ${hasOverflow ? 'pr-4' : ''}`}
    >
      <div className="pt-8 px-8 max-w-2xl mx-auto">
        <PageHeader title={t('storageSettings.title')} subtitle={t('storageSettings.intro')} onBack={onBack} />

        {/* Only a COLD read shows the calculating line. A hint-driven refetch keeps the numbers on
          screen while it runs — the store keeps the last value precisely so a background
          invalidation can't blank a panel the user is reading. */}
        {loading && !info ? (
          <p role="status" className="text-on-surface-variant py-8 text-center">{t('storageSettings.calculating')}</p>
        ) : info && (
          <div className="space-y-10">
            <section>
              <SectionHeading>{t('storageSettings.downloadFolder')}</SectionHeading>
              <div className="bg-surface-container-low rounded-xl p-6">
                <p id="storage-download-folder-desc" className="text-sm text-on-surface-variant mb-3">{t('storageSettings.downloadFolderDesc')}</p>
                {/* The same row Add Folder, Mirror to Disk, Edit Folder and Edit Space show — a path
                  is a path, whichever screen you are on. `lowest` because this card is itself
                  `surface-container-low`, which the field's default fill would vanish into. */}
                <PathRow
                  path={downloadFolder || null}
                  loading={downloadFolder === null}
                  onAction={handleBrowseFolder}
                  ariaDescribedBy="storage-download-folder-desc"
                  fill="lowest"
                />
                {/* A rejected pick leaves BOTH true — the old folder is still unavailable and the
                  new one was refused. Order matters for a screen reader: the rejection is what
                  just happened and what the user can act on, so it is announced first. */}
                {shownError && (
                  <InlineError className="mt-3">{t('storageSettings.folderError', { error: shownError })}</InlineError>
                )}
                {folderUnavailable && (
                  <InlineError className="mt-3">{t('storageSettings.folderUnavailable')}</InlineError>
                )}
              </div>
            </section>

            <section>
              <SectionHeading>{t('storageSettings.appStorage')}</SectionHeading>
              <AppStorageCard info={info} onOpenActivityLogSettings={onOpenActivityLogSettings} onLeftSpace={onLeftSpace} />
            </section>
          </div>
        )}
      </div>
    </div>
  )
}
