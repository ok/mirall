// Connecting this install to an organization from its activation link. Everything shown comes from
// the organization's signed configuration, which the worker fetches and verifies first; the link
// itself is trusted for nothing. Connect is a deliberate click: no onConfirm, so no key confirms.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { request } from '../../ipc/ipc.js'
import { useErrorText } from '../../hooks/useErrorText.js'
import { useRunAction } from '../../hooks/useRunAction.js'
import { useToast } from '../toast/ToastProvider.js'
import Modal from '../primitives/Modal.js'
import ModalHeader from '../primitives/ModalHeader.js'
import ModalFooter from '../layout/ModalFooter.js'
import Button from '../primitives/Button.js'
import Callout from '../primitives/Callout.js'
import type { ManagedOrganization, ManagedPreview } from '../../../shared/contract/responses.js'

type Ready = Extract<ManagedPreview, { kind: 'ready' }>

type ActivateState =
  | { s: 'checking' }
  | { s: 'ready'; preview: Ready; error: string | null }
  | { s: 'no-configuration' }
  | { s: 'unreachable' }
  | { s: 'invalid' }

type Failed = Extract<ActivateState, { s: 'no-configuration' | 'unreachable' | 'invalid' }>

const STILL_CHECKING_MS = 3000
const PREPARING_MS = 10_000

// The policy section that says what an organization learns from a computer it manages.
const PRIVACY_MANAGED = 'https://mirall.app/privacy#managed'
const LINK = 'font-headline font-bold text-secondary hover:underline focus-ring rounded'

const FAILED_COPY = {
  'no-configuration': { title: 'managed.activate.noConfigTitle', body: 'managed.activate.noConfigBody' },
  unreachable: { title: 'managed.activate.unreachableTitle', body: 'managed.activate.unreachableBody' },
  invalid: { title: 'managed.activate.invalidTitle', body: 'managed.activate.invalidBody' },
} as const

interface ManagedActivateModalProps {
  code: string | null
  onClose: () => void
}

export default function ManagedActivateModal({ code, onClose }: ManagedActivateModalProps) {
  const { t } = useTranslation()
  const toast = useToast()
  const errorText = useErrorText()
  const runAction = useRunAction()
  const [state, setState] = useState<ActivateState>({ s: 'checking' })
  const [attempt, setAttempt] = useState(0)
  const [connecting, setConnecting] = useState(false)

  useEffect(() => {
    if (!code) return
    let live = true
    setState({ s: 'checking' })
    request('managed:preview', { code }, 0)
      .then((preview) => {
        if (!live) return
        setState(preview.kind === 'ready' ? { s: 'ready', preview, error: null } : { s: preview.kind })
      })
      .catch(() => { if (live) setState({ s: 'unreachable' }) })
    return () => { live = false }
  }, [code, attempt])

  if (!code) return null

  async function connect(preview: Ready) {
    if (!code || connecting) return
    setConnecting(true)
    try {
      await request('managed:accept', { code }, 0)
      onClose()
      toast.success(t('managed.connectedToast', { org: preview.organization.name }))
    } catch (err) {
      setState({ s: 'ready', preview, error: errorText(err) })
    } finally {
      setConnecting(false)
    }
  }

  const title = state.s === 'ready' ? readyTitle(state.preview, t) : t(state.s === 'checking' ? 'managed.activate.title' : FAILED_COPY[state.s].title)

  return (
    <Modal isOpen onClose={onClose} isDismissable={!connecting} ariaLabel={title} ariaDescribedBy="managed-activate-body" panelClassName="glass-modal w-full max-w-md rounded-3xl shadow-2xl shadow-black/30 overflow-hidden relative">
      <>
        <ModalHeader title={title} onClose={onClose} closeDisabled={connecting} />
        <div className="px-10 pb-10 space-y-6">
          {state.s === 'checking' && (
            <>
              <Checking />
              <ModalFooter>
                <Button size="lg" variant="secondary" onClick={onClose}>{t('actions.cancel')}</Button>
              </ModalFooter>
            </>
          )}
          {state.s === 'ready' && (
            <ReadyBody
              preview={state.preview}
              error={state.error}
              connecting={connecting}
              onConnect={() => runAction(() => connect(state.preview))}
              onClose={onClose}
            />
          )}
          {state.s !== 'checking' && state.s !== 'ready' && (
            <FailedBody state={state} onClose={onClose} onRetry={() => setAttempt((n) => n + 1)} />
          )}
        </div>
      </>
    </Modal>
  )
}

function readyTitle(preview: Ready, t: TFunction): string {
  const org = preview.organization.name
  return preview.alreadyConnected ? t('managed.activate.alreadyTitle', { org }) : t('managed.activate.readyTitle', { org })
}

// One status region whose text changes twice, at 3 and at 10 seconds: announced once each, never
// on a tick.
function Checking() {
  const { t } = useTranslation()
  const [stage, setStage] = useState<'checking' | 'stillChecking' | 'preparing'>('checking')
  useEffect(() => {
    const later = setTimeout(() => setStage('stillChecking'), STILL_CHECKING_MS)
    const latest = setTimeout(() => setStage('preparing'), PREPARING_MS)
    return () => { clearTimeout(later); clearTimeout(latest) }
  }, [])
  return (
    <div role="status" className="space-y-2">
      <p id="managed-activate-body" className="text-on-surface-variant font-medium">{t(`managed.activate.${stage}`)}</p>
      {stage !== 'checking' && <p className="text-sm text-on-surface-variant">{t(`managed.activate.${stage}Hint`)}</p>}
    </div>
  )
}

interface FailedBodyProps {
  state: Failed
  onClose: () => void
  onRetry: () => void
}

function FailedBody({ state, onClose, onRetry }: FailedBodyProps) {
  const { t } = useTranslation()
  return (
    <>
      <p id="managed-activate-body" className="text-on-surface-variant font-medium">{t(FAILED_COPY[state.s].body)}</p>
      <ModalFooter>
        <Button size="lg" variant="secondary" onClick={onClose}>{t('actions.close')}</Button>
        {state.s === 'unreachable' && <Button size="lg" onClick={onRetry}>{t('managed.activate.tryAgain')}</Button>}
      </ModalFooter>
    </>
  )
}

interface ReadyBodyProps {
  preview: Ready
  error: string | null
  connecting: boolean
  onConnect: () => void
  onClose: () => void
}

function ReadyBody({ preview, error, connecting, onConnect, onClose }: ReadyBodyProps) {
  const { t } = useTranslation()
  const org = preview.organization

  if (preview.alreadyConnected) {
    return (
      <>
        <p id="managed-activate-body" className="text-on-surface-variant font-medium">{t('managed.activate.alreadyBody')}</p>
        <ModalFooter>
          <Button size="lg" onClick={onClose}>{t('actions.close')}</Button>
        </ModalFooter>
      </>
    )
  }

  return (
    <>
      <p id="managed-activate-body" className="text-on-surface-variant font-medium">{t('managed.activate.readyBody', { org: org.name })}</p>
      <p className="text-sm text-on-surface-variant">
        {t('managed.activate.sees', { org: org.name })}{' '}
        <a href={PRIVACY_MANAGED} target="_blank" rel="noreferrer" className={LINK}>
          {t('managed.activate.privacy')}<span className="sr-only"> {t('managed.activate.opensInBrowser')}</span>
        </a>
      </p>
      {preview.replaces && <Callout tone="warning">{t('managed.activate.replaces', { previous: preview.replaces })}</Callout>}
      <Contact org={org} />
      {error && (
        <div className="rounded-xl bg-error-container/60 px-5 py-3 text-sm font-medium text-on-error-container" role="alert">{error}</div>
      )}
      <p className="text-sm text-on-surface-variant">{t('managed.activate.leaveLater')}</p>
      <ModalFooter>
        <Button size="lg" variant="secondary" onClick={onClose} disabled={connecting}>{t('managed.activate.notNow')}</Button>
        <Button size="lg" onClick={onConnect} ariaDisabled={connecting}>
          {t(connecting ? 'managed.activate.connecting' : error ? 'managed.activate.tryAgain' : 'managed.activate.connect')}
        </Button>
      </ModalFooter>
    </>
  )
}

function Contact({ org }: { org: ManagedOrganization }) {
  const { t } = useTranslation()
  if (!org.supportEmail && !org.supportUrl) return null
  return (
    <p className="text-sm text-on-surface-variant">
      {t('managed.activate.questions')}{' '}
      {org.supportEmail && <a href={`mailto:${org.supportEmail}`} target="_blank" rel="noreferrer" className={LINK}>{org.supportEmail}</a>}
      {org.supportEmail && org.supportUrl && ' · '}
      {org.supportUrl && (
        <a href={org.supportUrl} target="_blank" rel="noreferrer" className={LINK}>
          {t('managed.activate.supportPage')}<span className="sr-only"> {t('managed.activate.opensInBrowser')}</span>
        </a>
      )}
    </p>
  )
}
