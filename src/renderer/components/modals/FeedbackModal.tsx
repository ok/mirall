// Feedback form submitted through the worker; optionally attaches a screenshot
// of the app, hiding itself during capture.
import { useState, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { domToPng } from 'modern-screenshot'
import { request } from '../../ipc.js'
import { getFeedbackEmail, setFeedbackEmail } from '../../config-client.js'
import Modal from '../primitives/Modal.js'
import Icon from '../primitives/Icon.js'
import IconButton from '../primitives/IconButton.js'
import Button from '../primitives/Button.js'

interface FeedbackModalProps {
  isOpen: boolean
  onClose: () => void
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
// Telegram's caption cap is 1024 with a photo. The worker prepends ~150 chars
// of metadata (name, email, version, platform, timestamp) before forwarding,
// so capping the user-visible field at 800 ensures nothing they type is
// trimmed downstream.
const COMMENT_MAX_LENGTH = 800

function loadStoredEmail(): string {
  return getFeedbackEmail()
}

function persistEmail(email: string): void {
  setFeedbackEmail(email)
}

async function captureScreenshot(modalEl: HTMLDivElement | null): Promise<string | null> {
  if (modalEl) modalEl.style.display = 'none'
  try {
    await new Promise((r) => requestAnimationFrame(r))
    const root = document.getElementById('root')
    if (!root) return null
    const dataUrl = await domToPng(root, { scale: 1 })
    return dataUrl.split(',')[1] || null
  } catch (err) {
    console.error('Screenshot capture failed:', err)
    return null
  } finally {
    if (modalEl) modalEl.style.display = ''
  }
}

function FeedbackSentView({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="px-10 py-16 flex flex-col items-center text-center space-y-4">
      <Icon name="check_circle" size={64} className="text-accent" />
      <h2 className="font-headline text-2xl font-extrabold text-accent tracking-tight">
        {t('feedback.titleSent')}
      </h2>
      <p className="text-on-surface-variant font-medium text-sm">
        {t('feedback.thanks')}
      </p>
      <Button size="lg" fullWidth onClick={onDone} className="mt-4">
        {t('actions.done')}
      </Button>
    </div>
  )
}

export default function FeedbackModal({ isOpen, onClose }: FeedbackModalProps) {
  const { t } = useTranslation()
  const { t: tErr } = useTranslation('errors')
  const [comment, setComment] = useState('')
  const [email, setEmail] = useState<string>(loadStoredEmail)
  const [includeScreenshot, setIncludeScreenshot] = useState(false)
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const modalRef = useRef<HTMLDivElement | null>(null)

  function handleClose() {
    if (sending) return
    setComment('')
    setSending(false)
    setSent(false)
    setError(null)
    onClose()
  }

  const trimmedEmail = email.trim()
  const emailValid = trimmedEmail === '' || EMAIL_PATTERN.test(trimmedEmail)
  const isValid = comment.trim().length >= 3 && emailValid

  async function handleSubmit() {
    if (sending || !isValid) return
    setSending(true)
    setError(null)

    try {
      const screenshot = includeScreenshot ? await captureScreenshot(modalRef.current) : null
      await request('feedback:send', {
        comment: comment.trim(),
        screenshot,
        email: trimmedEmail || null,
      })
      persistEmail(trimmedEmail)
      setSent(true)
    } catch (err) {
      if (err instanceof Error && err.message === 'rate_limited') {
        setError(tErr('feedbackRateLimited'))
      } else {
        setError(err instanceof Error ? err.message : tErr('feedbackFailed'))
      }
    } finally {
      setSending(false)
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      onConfirm={sent ? undefined : handleSubmit}
      isDismissable={!sending}
      ariaLabel={t(sent ? 'feedback.titleSent' : 'feedback.titleNew')}
      panelClassName="glass-modal w-full max-w-md rounded-3xl shadow-2xl shadow-black/30 overflow-hidden relative"
      ref={modalRef}
    >
      <>
        {sent ? (
          <FeedbackSentView onDone={handleClose} />
        ) : (
          <>
            <div className="px-10 pt-10 pb-6">
              <div className="flex justify-between items-start mb-2">
                <h1 className="font-headline text-2xl font-extrabold text-accent tracking-tight">
                  {t('feedback.titleNew')}
                </h1>
                <IconButton
                  icon="close"
                  onClick={handleClose}
                  ariaLabel={t('actions.close')}
                  iconClassName="text-secondary"
                />
              </div>
              <p className="text-on-surface-variant font-medium text-sm">
                {t('feedback.intro')}
              </p>
            </div>
            <div className="px-10 pb-10 space-y-6">
              <div className="space-y-3">
                <label htmlFor="feedback-message" className="font-headline text-sm font-bold text-accent px-1">{t('feedback.messageLabel')}</label>
                <textarea
                  id="feedback-message"
                  autoFocus
                  maxLength={COMMENT_MAX_LENGTH}
                  className="w-full h-32 bg-surface-container-low border-none focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30 rounded-xl px-6 py-4 text-accent font-medium placeholder:text-outline/50 transition-all resize-none"
                  placeholder={t('feedback.messagePlaceholder')}
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                />
                <p className="px-1 text-xs font-medium text-on-surface-variant/70 text-right tabular-nums">
                  {comment.length} / {COMMENT_MAX_LENGTH}
                </p>
              </div>
              <div className="space-y-3">
                <label htmlFor="feedback-email" className="font-headline text-sm font-bold text-accent px-1">{t('feedback.emailLabel')} <span className="font-medium text-on-surface-variant/70">{t('feedback.emailOptional')}</span></label>
                <input
                  id="feedback-email"
                  type="email"
                  autoComplete="email"
                  inputMode="email"
                  aria-invalid={!emailValid}
                  aria-describedby={!emailValid ? 'feedback-email-error' : undefined}
                  className="w-full h-14 bg-surface-container-low border-none focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30 rounded-xl px-6 text-accent font-medium placeholder:text-outline/50 transition-all"
                  placeholder={t('feedback.emailPlaceholder')}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
                {!emailValid && (
                  <p id="feedback-email-error" role="alert" className="px-1 text-xs font-medium text-error">{t('feedback.emailInvalid')}</p>
                )}
              </div>
              <label className="flex items-center gap-3 cursor-pointer px-1">
                <input
                  type="checkbox"
                  checked={includeScreenshot}
                  onChange={(e) => setIncludeScreenshot(e.target.checked)}
                  className="w-4 h-4 shrink-0 rounded accent-primary cursor-pointer"
                />
                <span className="text-sm text-on-surface-variant font-medium">{t('feedback.screenshotLabel')}</span>
              </label>
              {error && (
                <div role="alert" className="flex items-start gap-3 bg-error-container/30 rounded-xl p-4">
                  <Icon name="error" size={20} className="text-error" />
                  <p className="text-sm text-on-error-container font-medium">{error}</p>
                </div>
              )}
              <div className="flex gap-3">
                <Button variant="secondary" size="lg" onClick={handleClose} className="flex-1">
                  {t('actions.cancel')}
                </Button>
                <Button size="lg" onClick={handleSubmit} disabled={sending || !isValid} className="flex-1">
                  {sending ? t('actions.sending') : t('actions.send')}
                  {!sending && <Icon name="send" size={20} />}
                </Button>
              </div>
            </div>
          </>
        )}
      </>
    </Modal>
  )
}
