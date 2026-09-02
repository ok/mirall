// Storage settings: download-folder picker and the app-storage usage breakdown.
import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { request } from '../ipc.js'
import { formatSize } from '../utils.js'
import { mountErrorI18nKey } from '../errorMessages.js'
import { useHasVerticalOverflow } from '../hooks/useHasVerticalOverflow.js'
import { useQuery } from '../store/useQuery.js'
import { useDownloadRootStatus } from '../hooks/useDownloadRootStatus.js'
import CopyButton from '../components/primitives/CopyButton.js'
import FilePath from '../components/widgets/FilePath.js'
import Icon from '../components/primitives/Icon.js'
import PathRow from '../components/widgets/PathRow.js'
import PageHeader from '../components/layout/PageHeader.js'
import SectionHeading from '../components/layout/SectionHeading.js'

// Module-level so the entry's scope list is one array, not a fresh literal per render.
const STORAGE_SCOPES = [{ kind: 'files' }, { kind: 'shares' }, { kind: 'share-files' }]

interface StorageInfo {
  totalDiskUsage: number
  storagePath: string
  indexBytes: number
  dbBytes: number
}

interface StorageSettingsProps {
  onBack: () => void
}

function StorageTotal({ info }: { info: StorageInfo }) {
  const label = formatSize(info.totalDiskUsage)
  const number = label.split(' ')[0]
  const unit = label.split(' ')[1] || 'B'
  return (
    <>
      <div className="flex items-baseline gap-2 mb-3">
        <span className="text-5xl font-headline font-extrabold text-accent tracking-tighter">{number}</span>
        <span className="text-xl font-headline font-bold text-on-surface-variant/60">{unit}</span>
      </div>
      <div className="flex items-center gap-2">
        <FilePath path={info.storagePath} className="flex-1 text-xs font-medium text-on-surface-variant" />
        <CopyButton value={info.storagePath} className="opacity-0 group-hover/copy:opacity-100 focus:opacity-100 transition-opacity" />
      </div>
    </>
  )
}

function Category({ heading, desc, bytes }: { heading: string; desc: string; bytes: number }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-on-surface-variant">{heading}</p>
        <p className="text-xs text-on-surface-variant">{desc}</p>
      </div>
      <p className="text-sm font-semibold text-on-surface-variant shrink-0 tabular-nums">{formatSize(bytes)}</p>
    </div>
  )
}

function StorageBreakdown({ info }: { info: StorageInfo }) {
  const { t } = useTranslation()
  return (
    <>
      <Category heading={t('storageSettings.sharingIndex')} desc={t('storageSettings.sharingIndexDesc')} bytes={info.indexBytes} />
      <Category heading={t('storageSettings.appDatabase')} desc={t('storageSettings.appDatabaseDesc')} bytes={info.dbBytes} />
    </>
  )
}

// Trailing separators and Unicode composition are the two ways the same folder reaches us
// spelled differently; neither changes which folder it is.
function samePath(a: string, b: string) {
  const strip = (p: string) => p.replace(/[/\\]+$/, '').normalize('NFC')
  return strip(a) === strip(b)
}

export default function StorageSettings({ onBack }: StorageSettingsProps) {
  const { t } = useTranslation()
  const { t: tErr } = useTranslation('errors')
  const [downloadFolder, setDownloadFolder] = useState<string>('')
  const [folderError, setFolderError] = useState<string | null>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const { unavailable: unavailableRoots, refresh: refreshRootStatus } = useDownloadRootStatus()

  // storage:info is a cross-space disk aggregate, so it watches the file, share and share-file
  // scopes without pinning a spaceId — a hint for any space matches (scopeMatches only compares an
  // id the VIEW pins). The coalesce window matters here: an owned-folder scan pokes files-updated
  // in bursts, and this read walks the store.
  const { data: info, loading } = useQuery<StorageInfo>('storage:info', {}, STORAGE_SCOPES, { coalesceMs: 750 })

  const toggleDetails = useCallback(() => setDetailsOpen((open) => !open), [])

  useEffect(() => {
    let cancelled = false
    window.bridge.getDownloadFolder()
      .then((folder) => { if (!cancelled) setDownloadFolder(folder) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  const handleBrowseFolder = useCallback(async () => {
    setFolderError(null)
    try {
      const picked = await window.bridge.browseDownloadFolder()
      if (!picked) return
      // The WORKER validates first: only it can see the owned/mirrored folders a download
      // root must not overlap. Persisting in main first would leave a rejected folder in the
      // config, and the next launch would spawn the worker on it with nothing left to check it.
      await request('settings:set-download-folder', { folder: picked })
      setDownloadFolder(await window.bridge.setDownloadFolder(picked))
      // The picker only accepts a folder that validated, so the warning below is stale the
      // moment this resolves — re-probe rather than leaving it up until the next 60s tick.
      await refreshRootStatus()
    } catch (err) {
      const key = mountErrorI18nKey((err as { code?: string } | null)?.code)
      setFolderError(key ? tErr(key) : err instanceof Error ? err.message : String(err))
    }
  }, [tErr, refreshRootStatus])

  // This screen shows the GLOBAL root; `unavailableRoots` also carries per-space overrides, so
  // match rather than test for a non-empty list. The two strings reach us by different routes —
  // main stores the path the picker returned, the worker stores its own resolved + NFC-normalized
  // copy — so compare them normalized instead of raw, or a folder with an umlaut in its name
  // silently fails to match and the warning never shows.
  const folderUnavailable = downloadFolder.length > 0
    && unavailableRoots.some((root) => samePath(root, downloadFolder))

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
                placeholder={t('storageSettings.calculating')}
                onAction={handleBrowseFolder}
                ariaDescribedBy="storage-download-folder-desc"
                fill="lowest"
              />
              {/* A rejected pick leaves BOTH true — the old folder is still unavailable and the
                  new one was refused. Order matters for a screen reader: the rejection is what
                  just happened and what the user can act on, so it is announced first. */}
              {folderError && (
                <p className="mt-3 text-sm text-error" role="alert">{t('storageSettings.folderError', { error: folderError })}</p>
              )}
              {folderUnavailable && (
                <p className="mt-3 text-sm text-error" role="alert">{t('storageSettings.folderUnavailable')}</p>
              )}
            </div>
          </section>

          <section>
            <SectionHeading>{t('storageSettings.appStorage')}</SectionHeading>
            <div className="bg-surface-container-low rounded-xl">
              <div className="group/copy p-6">
                <StorageTotal info={info} />
                <p className="text-sm text-on-surface-variant mt-3 leading-relaxed">{t('storageSettings.appStorageDesc')}</p>
              </div>
              {info.totalDiskUsage > 0 && (
                <>
                  <button
                    type="button"
                    onClick={toggleDetails}
                    aria-expanded={detailsOpen}
                    aria-controls="appstorage-breakdown"
                    className="w-full px-6 py-4 flex items-center justify-between text-left border-t border-outline-variant/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30"
                  >
                    <span className="text-sm font-semibold text-on-surface-variant">{detailsOpen ? t('storageSettings.hideDetails') : t('storageSettings.showDetails')}</span>
                    <Icon name={detailsOpen ? 'expand_more' : 'chevron_right'} className="text-outline" />
                  </button>
                  {detailsOpen && (
                    <div id="appstorage-breakdown" className="px-6 pb-6 pt-2 space-y-4">
                      <StorageBreakdown info={info} />
                    </div>
                  )}
                </>
              )}
            </div>
          </section>
        </div>
      )}
      </div>
    </div>
  )
}
