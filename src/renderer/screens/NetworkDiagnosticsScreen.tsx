// Diagnostics: builds the support bundle and previews what goes in it. Its own screen below
// Network status, because detailed logging stays on only while this screen is mounted.
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { buildBundle, serialiseBundle, bundleFilename, previewText } from '../platform/diagnostics-bundle.js'
import { request } from '../ipc/ipc.js'
import DiagnosticsPreviewModal from '../components/modals/DiagnosticsPreviewModal.js'
import Toggle from '../components/primitives/Toggle.js'
import Button from '../components/primitives/Button.js'
import { useErrorText } from '../hooks/useErrorText.js'
import { useRunAction } from '../hooks/useRunAction.js'
import { useHasVerticalOverflow } from '../hooks/useHasVerticalOverflow.js'
import PageHeader from '../components/layout/PageHeader.js'

interface Props {
  onBack: () => void
}

export default function NetworkDiagnosticsScreen({ onBack }: Props) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const runAction = useRunAction()
  const verboseSeqRef = useRef(0)
  const includeLogsRef = useRef(false)
  const { ref, hasOverflow } = useHasVerticalOverflow<HTMLDivElement>()
  const [redact, setRedact] = useState(true)
  const [includeLogs, setIncludeLogs] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ text: string; bytes: number; redacted: boolean; serialised: string; filename: string } | null>(null)

  // Detailed logging stays on only while this screen is mounted. Leaving also makes every write
  // still in flight stale, so a late reply cannot switch main back on.
  useEffect(() => {
    return () => {
      verboseSeqRef.current += 1
      if (includeLogsRef.current) {
        window.bridge.setVerbose(false).catch(() => {})
        request('setVerbose', { verbose: false }).catch(() => {})
      }
    }
  }, [])

  function showLogs(on: boolean) {
    includeLogsRef.current = on
    setIncludeLogs(on)
  }

  function saveSerialised(serialised: string, filename: string) {
    const blob = new Blob([serialised], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    link.click()
    URL.revokeObjectURL(url)
  }

  async function run(action: 'save' | 'preview') {
    if (busy) return
    setBusy(true)
    setStatus(null)
    try {
      const bundle = await buildBundle({ redact, includeLogs })
      const serialised = serialiseBundle(bundle)
      if (action === 'preview') {
        setPreview({
          text: previewText(serialised, t('diagnostics.previewTruncated')),
          bytes: serialised.length,
          redacted: redact,
          serialised,
          filename: bundleFilename(bundle),
        })
        return
      }
      saveSerialised(serialised, bundleFilename(bundle))
      setPreview(null)
      setStatus(t('diagnostics.saved'))
    } catch (err) {
      setStatus(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  // Detailed logging has to be on while the user reproduces the problem, otherwise the
  // lines we need are the ones that were never recorded.
  //
  // The toggle shows what the worker IS doing, not what this screen asked for: verbose is shared —
  // one client releasing it does not switch it off while another still wants it — so the reply is
  // the answer and the optimistic value is only the starting point. The worker is written before
  // main because its reply is that answer: a rejection returns the switch to where it was with
  // nothing written anywhere, and main is then given the same answer. The status sentence is said
  // only once both have taken it. Only the latest click's reply is applied.
  function handleIncludeLogs(next: boolean) {
    const seq = ++verboseSeqRef.current
    const previous = includeLogsRef.current
    showLogs(next)
    runAction(async () => {
      const reply = await request('setVerbose', { verbose: next }).catch((err: Error) => {
        if (seq !== verboseSeqRef.current) return null
        showLogs(previous)
        throw err
      })
      if (seq !== verboseSeqRef.current) return
      const effective = typeof reply?.verbose === 'boolean' ? reply.verbose : next
      showLogs(effective)
      await window.bridge.setVerbose(effective)
      if (seq === verboseSeqRef.current) setStatus(effective ? t('diagnostics.verboseOn') : null)
    })
  }

  return (
    <div
      ref={ref}
      className={`relative h-[calc(100vh-5.5rem-var(--banner-h,0px))] overflow-y-auto scrollbar-thin pb-8 mr-2 ${hasOverflow ? 'pr-4' : ''}`}
    >
      <div className="pt-8 px-8 max-w-2xl mx-auto">
        <PageHeader
          title={t('diagnostics.title')}
          subtitle={t('diagnostics.rowDesc')}
          onBack={onBack}
        />

        <div className="bg-surface-container-low rounded-xl p-6 space-y-5">
          <p className="text-sm text-on-surface-variant leading-relaxed">{t('diagnostics.intro')}</p>

          <div className="rounded-xl bg-surface-container-lowest overflow-hidden divide-y divide-surface-container-high/30">
            <Toggle
              label={t('diagnostics.redactLabel')}
              description={t('diagnostics.redactDescription')}
              checked={redact}
              onChange={setRedact}
            />
            <Toggle
              label={t('diagnostics.logsLabel')}
              description={t('diagnostics.logsDescription')}
              checked={includeLogs}
              onChange={handleIncludeLogs}
            />
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <Button icon="download" onClick={() => run('save')} disabled={busy}>
              {t('diagnostics.save')}
            </Button>
            <Button variant="secondary" onClick={() => run('preview')} disabled={busy}>
              {t('diagnostics.preview')}
            </Button>
            {/* In the button row, not under it: the region stays mounted for the announcement while
                an empty status adds no height, so the card keeps its own padding as its bottom edge. */}
            <p role="status" aria-live="polite" className="text-xs text-on-surface-variant">
              {status ?? ''}
            </p>
          </div>
        </div>

        <DiagnosticsPreviewModal
          isOpen={preview !== null}
          text={preview?.text ?? ''}
          byteLength={preview?.bytes ?? 0}
          redacted={preview?.redacted ?? true}
          onSave={() => {
            if (preview) saveSerialised(preview.serialised, preview.filename)
            setPreview(null)
            setStatus(t('diagnostics.saved'))
          }}
          onClose={() => setPreview(null)}
        />
      </div>
    </div>
  )
}
