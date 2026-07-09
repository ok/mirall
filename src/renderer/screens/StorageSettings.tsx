// Storage settings: download-folder picker, app-storage usage breakdown, and a reclaim-space action.
import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { request } from '../ipc.js'
import { formatSize } from '../utils.js'
import { useHasVerticalOverflow } from '../hooks/useHasVerticalOverflow.js'
import CopyButton from '../components/primitives/CopyButton.js'
import FilePath from '../components/widgets/FilePath.js'
import Icon from '../components/primitives/Icon.js'
import PageHeader from '../components/layout/PageHeader.js'
import SectionHeading from '../components/layout/SectionHeading.js'

interface StorageInfo {
  totalDiskUsage: number
  storagePath: string
  indexBytes: number
  dbBytes: number
}

interface StorageSettingsProps {
  onBack: () => void
}

const ACTION_BUTTON = 'shrink-0 bg-surface-container-high dark:bg-surface-container-highest text-accent rounded-xl px-5 py-2.5 font-headline font-bold text-sm hover:bg-surface-container-highest dark:hover:bg-surface-container-high active:scale-95 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30'

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

function StorageBreakdown({ info, freeing, freedBytes, onFreeSpace }: { info: StorageInfo; freeing: boolean; freedBytes: number | null; onFreeSpace: () => void }) {
  const { t } = useTranslation()
  const status = freeing
    ? t('storageSettings.reclaimRunning')
    : freedBytes === null ? ''
      : freedBytes > 0 ? t('storageSettings.reclaimDone', { size: formatSize(freedBytes) })
        : t('storageSettings.reclaimNone')
  return (
    <>
      <Category heading={t('storageSettings.sharingIndex')} desc={t('storageSettings.sharingIndexDesc')} bytes={info.indexBytes} />
      <Category heading={t('storageSettings.appDatabase')} desc={t('storageSettings.appDatabaseDesc')} bytes={info.dbBytes} />
      <div className="flex items-center justify-between gap-4 pt-3 border-t border-outline-variant/40">
        <p role="status" aria-live="polite" className="text-xs text-on-surface-variant min-w-0">{status}</p>
        <button type="button" onClick={onFreeSpace} disabled={freeing} className={`${ACTION_BUTTON} disabled:opacity-50 disabled:pointer-events-none`}>
          {t('storageSettings.reclaimAction')}
        </button>
      </div>
    </>
  )
}

export default function StorageSettings({ onBack }: StorageSettingsProps) {
  const { t } = useTranslation()
  const [info, setInfo] = useState<StorageInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [downloadFolder, setDownloadFolder] = useState<string>('')
  const [folderError, setFolderError] = useState<string | null>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [freeing, setFreeing] = useState(false)
  const [freedBytes, setFreedBytes] = useState<number | null>(null)
  const freeingRef = useRef(false)

  const refreshInfo = useCallback(() => {
    return request('storage:info').then((data) => {
      setInfo(data as StorageInfo)
      setLoading(false)
    })
  }, [])

  const toggleDetails = useCallback(() => setDetailsOpen((open) => !open), [])

  const handleFreeSpace = useCallback(async () => {
    if (freeingRef.current) return
    freeingRef.current = true
    setFreeing(true)
    setFreedBytes(null)
    try {
      const res = await request('storage:free-space', {}, 0) as { freedBytes: number }
      setFreedBytes(res.freedBytes)
      await refreshInfo()
    } finally {
      setFreeing(false)
      freeingRef.current = false
    }
  }, [refreshInfo])

  useEffect(() => { refreshInfo() }, [refreshInfo])

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
      const persisted = await window.bridge.setDownloadFolder(picked)
      await request('settings:set-download-folder', { folder: persisted })
      setDownloadFolder(persisted)
    } catch (err) {
      setFolderError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const { ref, hasOverflow } = useHasVerticalOverflow<HTMLDivElement>()

  return (
    <div
      ref={ref}
      className={`h-[calc(100vh-5.5rem-var(--banner-h,0px))] overflow-y-auto scrollbar-thin pb-8 mr-2 ${hasOverflow ? 'pr-4' : ''}`}
    >
      <div className="pt-8 px-8 max-w-2xl mx-auto">
      <PageHeader title={t('storageSettings.title')} subtitle={t('storageSettings.intro')} onBack={onBack} />

      {loading ? (
        <p role="status" className="text-on-surface-variant py-8 text-center">{t('storageSettings.calculating')}</p>
      ) : info && (
        <div className="space-y-10">
          <section>
            <SectionHeading>{t('storageSettings.downloadFolder')}</SectionHeading>
            <div className="bg-surface-container-low rounded-xl p-6">
              <p className="text-sm text-on-surface-variant mb-3">{t('storageSettings.downloadFolderDesc')}</p>
              <div className="flex items-center gap-3">
                {downloadFolder ? (
                  <FilePath path={downloadFolder} className="flex-1 text-sm text-accent" />
                ) : (
                  <p className="flex-1 min-w-0 truncate text-sm text-on-surface-variant">{t('storageSettings.calculating')}</p>
                )}
                <button type="button" onClick={handleBrowseFolder} className={ACTION_BUTTON}>
                  {t('storageSettings.changeFolder')}
                </button>
              </div>
              {folderError && (
                <p className="mt-3 text-sm text-error" role="alert">{t('storageSettings.folderError', { error: folderError })}</p>
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
                      <StorageBreakdown info={info} freeing={freeing} freedBytes={freedBytes} onFreeSpace={handleFreeSpace} />
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
