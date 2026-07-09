// Creates a space invite (optional auto-approve and expiry) and presents the
// resulting mirall://join link for copying.
import { Fragment, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from '../primitives/Modal.js'
import Icon from '../primitives/Icon.js'
import IconButton from '../primitives/IconButton.js'
import Button from '../primitives/Button.js'
import Toggle from '../primitives/Toggle.js'

const EXPIRY = [
  { id: '2h', labelKey: 'invite.expiry.2h', ms: 2 * 60 * 60 * 1000 },
  { id: '2d', labelKey: 'invite.expiry.2d', ms: 2 * 24 * 60 * 60 * 1000 },
  { id: '2w', labelKey: 'invite.expiry.2w', ms: 14 * 24 * 60 * 60 * 1000 },
] as const

type ExpiryId = typeof EXPIRY[number]['id']

interface InviteModalProps {
  isOpen: boolean
  canAutoApprove?: boolean
  onClose: () => void
  onCreate: (opts: { autoApprove: boolean; expiresInMs: number }) => Promise<string | null>
}

const BADGE_BASE = 'inline-flex items-center leading-none px-3 pt-[7px] pb-[5px] text-[10px] font-bold rounded-full uppercase tracking-wider border border-outline'

export default function InviteModal({ isOpen, canAutoApprove, onClose, onCreate }: InviteModalProps) {
  const { t, i18n } = useTranslation()
  const [autoApprove, setAutoApprove] = useState(false)
  const [expiry, setExpiry] = useState<ExpiryId>('2h')
  const [code, setCode] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!isOpen) { setAutoApprove(false); setExpiry('2h'); setCode(null); setCreating(false); setCopied(false) }
  }, [isOpen])

  const chosen = EXPIRY.find((e) => e.id === expiry) ?? EXPIRY[0]
  const expiresLabel = new Date(Date.now() + chosen.ms).toLocaleDateString(i18n.language, { weekday: 'short', day: 'numeric', month: 'short' })

  async function handleCreate() {
    setCreating(true)
    const created = await onCreate({ autoApprove, expiresInMs: chosen.ms })
    setCreating(false)
    if (created) setCode(created)
  }

  function handleCopy() {
    if (!code) return
    navigator.clipboard.writeText(`mirall://join/${code}`)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      onConfirm={code ? onClose : handleCreate}
      ariaLabel={code ? t('invite.readyTitle') : t('invite.title')}
      panelClassName="glass-modal w-full max-w-md rounded-3xl shadow-2xl shadow-black/30 overflow-hidden relative"
    >
      <>
        <div className="px-10 pt-10 pb-6">
          <div className="flex justify-between items-start mb-2">
            <h1 className="font-headline text-2xl font-extrabold text-accent tracking-tight">
              {code ? t('invite.readyTitle') : t('invite.title')}
            </h1>
            <IconButton icon="close" onClick={onClose} ariaLabel={t('actions.close')} iconClassName="text-secondary" />
          </div>
          <p className="text-on-surface-variant font-medium text-sm">
            {code ? t('invite.readyDesc') : t('invite.configureDesc')}
          </p>
        </div>

        <div className="px-10 pb-10 space-y-5">
          {/* The two steps are keyed so the swap remounts cleanly — unkeyed, React reuses the
              button DOM across steps and `transition-all` animates Create morphing into Change. */}
          {code === null ? (
            <Fragment key="configure">
              {canAutoApprove && (
                <div className="bg-surface-container-low rounded-xl overflow-hidden">
                  <Toggle
                    label={t('invite.autoApprove')}
                    description={t('invite.autoApproveDesc')}
                    checked={autoApprove}
                    onChange={setAutoApprove}
                  />
                </div>
              )}

              {canAutoApprove && (
                <div className="space-y-3">
                  <p id="invite-expiry-label" className="font-headline text-sm font-bold text-accent px-1">{t('invite.expiresAfter')}</p>
                  <div role="group" aria-labelledby="invite-expiry-label" className="flex gap-1 bg-surface-container-low rounded-xl p-1">
                    {EXPIRY.map((e) => {
                      const selected = e.id === expiry
                      return (
                        <button
                          key={e.id}
                          type="button"
                          aria-pressed={selected}
                          onClick={() => setExpiry(e.id)}
                          className={
                            'flex-1 px-4 py-2 rounded-lg font-headline text-sm font-bold transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30 ' +
                            (selected ? 'bg-surface-container-lowest text-accent shadow-sm' : 'text-on-surface-variant hover:text-accent')
                          }
                        >
                          {t(e.labelKey)}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}

              <div className="flex items-start gap-3 bg-surface-container-low rounded-xl p-4">
                <Icon name="info" size={20} className="text-secondary shrink-0" />
                <p className="text-sm text-on-surface-variant font-medium">{t('invite.infoText')}</p>
              </div>

              <div className="pt-2">
                <Button size="lg" fullWidth icon="group_add" disabled={creating} onClick={handleCreate}>
                  {creating ? t('invite.creating') : t('invite.create')}
                </Button>
              </div>
            </Fragment>
          ) : (
            <Fragment key="ready">
              <div className="flex items-center gap-2 bg-surface-container-low rounded-xl p-2 pl-5">
                <span className="text-on-surface-variant font-medium text-sm truncate flex-grow font-mono">{`mirall://join/${code}`}</span>
                <button
                  onClick={handleCopy}
                  className="ml-auto flex items-center gap-2 bg-surface-container-lowest text-accent text-xs font-bold px-4 py-2.5 rounded-lg active:scale-95 transition-all shadow-sm shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30"
                >
                  <Icon name={copied ? 'check' : 'content_copy'} size={14} />
                  {copied ? t('actions.copied') : t('actions.copy')}
                </button>
              </div>

              {canAutoApprove && (
                <div className="flex flex-wrap items-center gap-2 px-1">
                  <span className={BADGE_BASE + (autoApprove ? ' bg-secondary-container text-on-secondary-container' : ' bg-surface-container-highest text-on-surface-variant')}>
                    {autoApprove ? t('invite.badge.auto') : t('invite.badge.review')}
                  </span>
                  <span className={BADGE_BASE + ' bg-surface-container-highest text-on-surface-variant'}>
                    {t('invite.badge.expires', { date: expiresLabel })}
                  </span>
                </div>
              )}

              <div className="flex items-start gap-3 bg-surface-container-low rounded-xl p-4">
                <Icon name="info" size={20} className="text-secondary shrink-0" />
                <p className="text-sm text-on-surface-variant font-medium">
                  {canAutoApprove
                    ? (autoApprove ? t('invite.autoNote', { date: expiresLabel }) : t('invite.reviewNote', { date: expiresLabel }))
                    : t('invite.infoText')}
                </p>
              </div>

              <div className="flex gap-3 pt-2">
                <Button size="lg" variant="secondary" className="flex-1" onClick={() => setCode(null)}>{t('actions.change')}</Button>
                <Button size="lg" className="flex-1" onClick={onClose}>{t('actions.done')}</Button>
              </div>
            </Fragment>
          )}
        </div>
      </>
    </Modal>
  )
}
