import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ModalFooter from '../layout/ModalFooter.js'
import { parseRelayInput, type RelayKind, type RelayParseErrorCode } from '../../platform/config-client.js'
import { truncateRelayKey } from '../../platform/relay-key.js'
import TextField from '../primitives/TextField.js'
import Badge from '../primitives/Badge.js'
import Button from '../primitives/Button.js'
import CopyButton from '../primitives/CopyButton.js'
import Icon from '../primitives/Icon.js'
import Modal from '../primitives/Modal.js'
import ModalHeader from '../primitives/ModalHeader.js'

interface AddRelayModalProps {
  isOpen: boolean
  replacing: boolean
  onClose: () => void
  // Resolves to null when the relay was stored, or the code to show when it was not: the modal
  // has to stay open on a failure, because closing it made a rejected add indistinguishable from
  // a click that did nothing.
  onAdd: (input: string, label: string) => Promise<RelayParseErrorCode | null>
}

const ERROR_KEY: Record<RelayParseErrorCode, string> = {
  'invalid-format': 'networkSettings.relays.error.format',
  'unsupported-version': 'networkSettings.relays.error.version',
  // Same sentence for both: one is an altered paste, the other a mis-sized one, and "copy the
  // whole thing" is the fix for either.
  'checksum-failed': 'networkSettings.relays.error.incomplete',
  'incomplete-invite': 'networkSettings.relays.error.incomplete',
  'save-failed': 'networkSettings.relays.error.save',
}

interface Decoded {
  kind: RelayKind
  publicKey: string
}

export default function AddRelayModal({ isOpen, replacing, onClose, onAdd }: AddRelayModalProps) {
  const { t } = useTranslation()
  const [input, setInput] = useState('')
  const [label, setLabel] = useState('')
  const [decoded, setDecoded] = useState<Decoded | null>(null)
  const [error, setError] = useState<RelayParseErrorCode | null>(null)
  const [checking, setChecking] = useState(false)
  const [saving, setSaving] = useState(false)
  // Mounted for the life of the section, so closing does not cancel an in-flight parse; the
  // generation drops a stale reply.
  const parseGen = useRef(0)

  function reset() {
    parseGen.current++
    setInput('')
    setLabel('')
    setDecoded(null)
    setError(null)
    setChecking(false)
    setSaving(false)
  }

  function handleClose() {
    reset()
    onClose()
  }

  async function handleContinue() {
    if (checking || !input.trim()) return
    const gen = ++parseGen.current
    setChecking(true)
    const result = await parseRelayInput(input.trim())
    if (gen !== parseGen.current) return
    setChecking(false)
    if (!result.ok) {
      setError(result.code)
      return
    }
    setDecoded({ kind: result.kind, publicKey: result.publicKey })
  }

  async function handleAdd() {
    if (!decoded || saving) return
    const gen = parseGen.current
    setSaving(true)
    const failure = await onAdd(input.trim(), label.trim())
    if (gen !== parseGen.current) return
    if (!failure) {
      reset()
      onClose()
      return
    }
    setSaving(false)
    setError(failure)
  }

  const title = replacing ? t('networkSettings.relays.replaceTitle') : t('networkSettings.relays.addTitle')

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      onConfirm={decoded ? handleAdd : handleContinue}
      ariaLabel={title}
      panelClassName="glass-modal w-full max-w-md rounded-3xl shadow-2xl shadow-black/30 overflow-hidden relative"
    >
      <>
        <ModalHeader
          title={title}
          description={decoded ? undefined : t('networkSettings.relays.addDesc')}
          descriptionSize="sm"
          onClose={handleClose}
        />
        <div className="px-10 pb-10 space-y-6">
          {/* Outside the step branch: a save that fails leaves the confirm step on screen, and
              the message has to be visible where the person actually is. */}
          {error && (
            <div id="add-relay-error" className="rounded-xl bg-error-container/60 px-5 py-3 text-sm font-medium text-on-error-container" role="alert">
              {t(ERROR_KEY[error])}
            </div>
          )}
          {decoded ? (
            <>
              <DecodedRelaySummary decoded={decoded} />

              {/* Unboxed, in the same voice as the step-1 description: the operator's view of your
                  presence and contacts is the one fact here that can change the answer, and this is
                  the last screen before the key is stored. An open relay has no lasting identity to
                  disclose, so it says nothing. The reconnect note that used to sit under this is
                  gone: RelaySettingsSection renders it as ReconnectNotice the moment this closes,
                  with the button that acts on it. */}
              {decoded.kind === 'private' && (
                <p className="text-sm text-on-surface-variant leading-relaxed">
                  {t('networkSettings.relays.privacyNote')}
                </p>
              )}

              <TextField
                id="add-relay-label"
                label={t('networkSettings.relays.labelLabel')}
                autoFocus
                placeholder={t('networkSettings.relays.labelPlaceholder')}
                value={label}
                onChange={setLabel}
              />

              <ModalFooter layout="end">
                <Button variant="secondary" onClick={() => { setDecoded(null); setError(null) }}>
                  {t('actions.back')}
                </Button>
                <Button onClick={handleAdd} disabled={saving}>
                  {t('networkSettings.relays.addAction')}
                </Button>
              </ModalFooter>
            </>
          ) : (
            <>
              <TextField
                id="add-relay-input"
                label={t('networkSettings.relays.inputLabel')}
                autoFocus
                mono
                invalid={!!error}
                describedBy={error ? 'add-relay-error' : undefined}
                placeholder={t('networkSettings.relays.inputPlaceholder')}
                value={input}
                onChange={(v) => { setInput(v); setError(null) }}
              />
              <ModalFooter layout="end">
                <Button variant="secondary" onClick={handleClose}>
                  {t('actions.cancel')}
                </Button>
                <Button onClick={handleContinue} disabled={checking || !input.trim()}>
                  {t('actions.continue')}
                  <Icon name="arrow_forward" size={16} />
                </Button>
              </ModalFooter>
            </>
          )}
        </div>
      </>
    </Modal>
  )
}

function DecodedRelaySummary({ decoded }: { decoded: Decoded }) {
  const { t } = useTranslation()
  return (
    // `surface-container-low` is the ramp step that pairs with a modal panel, which is
    // `surface-container-lowest` — the same fill FIELD_SURFACE gives the name field two rows down,
    // so card and field agree. The `-high` step this used to carry is the CONTROL surface, and in
    // dark it is lighter than the panel: a quiet summary on the loudest plate in the dialog.
    <div className="rounded-xl bg-surface-container-low px-5 py-4 flex items-center gap-3">
      <Badge
        label={t(`networkSettings.relays.kind.${decoded.kind}`)}
        srLabel={t('networkSettings.relays.kindFor', { kind: t(`networkSettings.relays.kind.${decoded.kind}`) })}
        classes={decoded.kind === 'private' ? 'bg-secondary-container text-on-secondary-container' : 'bg-info text-on-info'}
        className="shrink-0"
      />
      <span aria-hidden="true" className="ml-auto font-mono text-xs text-on-surface-variant truncate">
        {truncateRelayKey(decoded.publicKey)}
      </span>
      <span className="sr-only">{t('networkSettings.relays.decodedKey', { key: decoded.publicKey })}</span>
      <CopyButton value={decoded.publicKey} />
    </div>
  )
}
