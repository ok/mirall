// The one backup question the Spaces screen may ask: the offer to set one up, or, once set up, whether
// the recovery passphrase is still known. The worker decides which is due and when (prompt-rules.js);
// "Not now" tells it, and it decides when to ask again. Never blocks the screen and never more than one.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { request } from '../../ipc/ipc.js'
import { useBackupStatus } from '../../hooks/useBackupStatus.js'
import { useErrorText } from '../../hooks/useErrorText.js'
import { useToast } from '../toast/ToastProvider.js'
import Icon from '../primitives/Icon.js'
import Button from '../primitives/Button.js'
import TextButton from '../primitives/TextButton.js'
import BackupDialogs, { type BackupDialog } from './BackupDialogs.js'
import { useManagedBackupFolder } from '../../hooks/useManagedBackupFolder.js'

export default function BackupPromptCard() {
  const { t } = useTranslation()
  const toast = useToast()
  const errorText = useErrorText()
  const status = useBackupStatus()
  const [dialog, setDialog] = useState<BackupDialog>(null)
  const [busy, setBusy] = useState(false)
  const prompt = status?.prompt ?? null
  const managed = useManagedBackupFolder()

  async function notNow() {
    if (!prompt || busy) return
    setBusy(true)
    try {
      await request('backup:prompt', { prompt, action: 'snooze' })
      if (prompt === 'offer') toast.info(t('backup.laterToast'))
    } catch (err) {
      toast.error(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const offer = prompt === 'offer'
  // An organization that requires a backup is named, and the offer cannot be put off.
  const required = offer && managed.required && !!managed.org
  return (
    <>
      {prompt && (
        <section aria-labelledby="backup-prompt-title" className="bg-surface-container-low rounded-xl p-6 shrink-0 mb-4">
          <div className="flex items-start gap-4">
            <div className="w-10 h-10 rounded-full bg-icon-tile flex items-center justify-center text-on-icon-tile shrink-0">
              <Icon name={offer ? 'shield' : 'verified_user'} />
            </div>
            <div className="min-w-0">
              <h2 id="backup-prompt-title" className="font-headline font-bold text-accent mb-1">{t(offer ? 'backup.offerTitle' : 'backup.checkTitle')}</h2>
              <p className="text-sm text-on-surface-variant leading-relaxed mb-4 max-w-2xl">{required ? t('backup.requiredOfferBody', { org: managed.org }) : t(offer ? 'backup.offerBody' : 'backup.checkBody')}</p>
              <div className="flex items-center gap-4">
                <Button icon={offer ? 'shield' : undefined} onClick={() => setDialog(offer ? 'setup' : 'check')}>
                  {t(offer ? 'backup.setUp' : 'backup.checkNow')}
                </Button>
                {!required && <TextButton onClick={() => void notNow()}>{t('backup.notNow')}</TextButton>}
              </div>
            </div>
          </div>
        </section>
      )}
      <BackupDialogs open={dialog} onChange={setDialog} />
    </>
  )
}
