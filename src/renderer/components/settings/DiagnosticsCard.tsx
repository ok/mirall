import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { buildBundle, serialiseBundle, bundleFilename, previewText } from '../../diagnosticsBundle.js'
import { request } from '../../ipc.js'
import DiagnosticsPreviewModal from '../modals/DiagnosticsPreviewModal.js'
import Toggle from '../primitives/Toggle.js'
import Button from '../primitives/Button.js'
import { useErrorText } from '../../hooks/useErrorText.js'

export default function DiagnosticsCard() {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const [redact, setRedact] = useState(true)
  const [includeLogs, setIncludeLogs] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ text: string; bytes: number; redacted: boolean; serialised: string; filename: string } | null>(null)

  useEffect(() => {
    return () => {
      if (includeLogs) {
        window.bridge.setVerbose(false).catch(() => {})
        request('setVerbose', { verbose: false }).catch(() => {})
      }
    }
  }, [includeLogs])

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
  async function handleIncludeLogs(next: boolean) {
    setIncludeLogs(next)
    try {
      await window.bridge.setVerbose(next)
    } catch {}
    try {
      await request('setVerbose', { verbose: next })
    } catch {}
    setStatus(next ? t('diagnostics.verboseOn') : null)
  }

  return (
    <section>
      <h2 className="text-xl font-headline font-bold text-accent mb-4">{t('diagnostics.title')}</h2>
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
        </div>

        <p role="status" aria-live="polite" className="text-xs text-on-surface-variant min-h-4">
          {status ?? ''}
        </p>
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
    </section>
  )
}
