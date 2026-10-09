// Profile screen: display name and avatar; this device's connection, protection and activity log; the
// About row and help resources.
import InlineError from '../components/primitives/InlineError.js'
import { useState, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { NAME_MAX } from '../format/utils.js'
import { connectionDesc, activityDesc } from '../model/profile-rows.js'
import type { Profile } from '../types/types.js'
import { useHasVerticalOverflow } from '../hooks/useHasVerticalOverflow.js'
import { useQuery } from '../store/useQuery.js'
import { useConnectionStatus } from '../hooks/useConnectionStatus.js'
import { useUpdates } from '../hooks/useUpdates.js'
import { useAppBuild } from '../hooks/useAppBuild.js'
import { useKeyboard } from '../keyboard/KeyboardProvider.js'
import { useRunAction } from '../hooks/useRunAction.js'
import { useAvatarPicker } from '../hooks/useAvatarPicker.js'
import StatusDot from '../components/primitives/StatusDot.js'
import Icon from '../components/primitives/Icon.js'
import type { TFunction } from 'i18next'
import type { BackupStatus } from '../../shared/contract/responses.js'
import { UPDATE_STATE, type UpdateStatus } from '../../shared/contract/update-status.js'
import Avatar from '../components/primitives/Avatar.js'
import PageHeader from '../components/layout/PageHeader.js'
import SectionHeading from '../components/layout/SectionHeading.js'
import ActionRow, { LinkRow, ROW_GROUP, Tile } from '../components/layout/ActionRow.js'
import UpdateDot from '../components/about/UpdateDot.js'
import { updateDot, updateSummaryKey } from '../model/about-view.js'
import { useBackupStatus } from '../hooks/useBackupStatus.js'
import { useRestoreHold } from '../hooks/useRestoreHold.js'
import ProtectionDot from '../components/backup/ProtectionDot.js'
import { protectionLamp, backupSummary } from '../model/protection-view.js'
import { formatDateTime } from '../format/utils.js'

interface AccountProps {
  profile: Profile | null
  onSave: (data: { displayName: string; avatar: string | null }) => Promise<unknown>
  onBack: () => void
  onOpenNetworkStatus: () => void
  onOpenActivityLog: () => void
  onOpenBackup: () => void
  onOpenAbout: () => void
  onFeedback: () => void
}

function ProfileCard({ profile, onSave }: Pick<AccountProps, 'profile' | 'onSave'>) {
  const { t } = useTranslation()
  const runAction = useRunAction()
  const [displayName, setDisplayName] = useState(profile?.displayName || '')
  const { avatar, error: avatarError, onChange: handleAvatarChange } = useAvatarPicker(profile?.avatar || null)
  const [saving, setSaving] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  // A restored profile is read-only until the people it is shared with confirm it.
  const held = !useRestoreHold().canWriteProfile

  const hasChanges = displayName !== profile?.displayName || avatar !== profile?.avatar

  // The edits stay in the fields on a rejection, so the retry is one click.
  function handleSave() {
    if (!displayName.trim() || saving) return
    setSaving(true)
    runAction(async () => {
      try {
        await onSave({ displayName: displayName.trim(), avatar })
      } finally {
        setSaving(false)
      }
    })
  }

  return (
    <div className="bg-surface-container-low rounded-xl p-6 space-y-6">
      <div className="flex items-center gap-6">
        <button
          type="button"
          onClick={() => { if (!held) fileRef.current?.click() }}
          aria-label={t('settings.changeAvatar')}
          aria-disabled={held || undefined}
          aria-describedby={held ? 'account-held-reason' : undefined}
          className="relative w-20 h-20 rounded-full bg-surface flex items-center justify-center cursor-pointer overflow-hidden shrink-0 p-0 border-0 focus-ring"
        >
          <Avatar src={avatar} size="xl" fallback="silhouette" decorative />
          <div className={`absolute inset-0 bg-black/20 flex items-center justify-center transition-opacity ${avatar ? 'opacity-0 hover:opacity-100' : 'opacity-100'}`}>
            <Icon name="edit" size={20} className="text-white" />
          </div>
        </button>
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleAvatarChange} />
        <div className="flex-grow">
          <label htmlFor="account-display-name" className="block text-sm font-semibold text-accent mb-2">{t('settings.displayName')}</label>
          <input
            id="account-display-name"
            type="text"
            maxLength={NAME_MAX}
            aria-describedby={held ? 'account-display-name-count account-held-reason' : 'account-display-name-count'}
            readOnly={held}
            className="w-full bg-surface-container-lowest border-none rounded-xl px-4 py-3 text-on-surface placeholder:text-outline-variant focus-ring transition-all"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
          <p id="account-display-name-count" className="mt-1 text-xs text-on-surface-variant" aria-live="polite">
            {t('settings.displayNameCount', { count: displayName.length, max: NAME_MAX })}
          </p>
        </div>
      </div>
      {held && <p id="account-held-reason" className="text-xs text-on-surface-variant">{t('restore.heldReason')}</p>}
      {avatarError && (
        <InlineError size="xs">{avatarError}</InlineError>
      )}
      {hasChanges && (
        <button
          onClick={handleSave}
          disabled={!displayName.trim()}
          aria-disabled={saving || undefined}
          className="w-full bg-primary text-on-primary font-bold py-3 rounded-xl hover:bg-primary-hover active:scale-95 transition-all shadow-lg shadow-primary/10 disabled:opacity-50 aria-disabled:opacity-50 focus-ring"
        >
          {saving ? t('actions.saving') : t('actions.save')}
        </button>
      )}
    </div>
  )
}

function summaryText(status: BackupStatus, t: TFunction): string {
  const { key, at } = backupSummary(status)
  return t(key, at === null ? {} : { when: formatDateTime(at) })
}

function DeviceGroup({ onOpenNetworkStatus, onOpenActivityLog, onOpenBackup }: Pick<AccountProps, 'onOpenNetworkStatus' | 'onOpenActivityLog' | 'onOpenBackup'>) {
  const { t } = useTranslation()
  const { state: connectivityState, status: networkStatus } = useConnectionStatus()
  const backup = useBackupStatus()
  const lamp = backup ? protectionLamp(backup) : null
  // Through the query store for the dedup and cache, with NO scopes: this is a summary line, not a
  // live counter, and the audit scope would repaint it on every recorded event. Scope-less still
  // re-reads on each mount. ActivityLogSettings reads the same two entries.
  const { data: auditConfig } = useQuery('audit:get-config', {}, null)
  const { data: auditStats } = useQuery('audit:stats', {}, null)

  return (
    <section>
      <SectionHeading>{t('account.groupDevice')}</SectionHeading>
      <div className={ROW_GROUP}>
        <ActionRow
          label={t('account.connection')}
          desc={connectionDesc(t, connectivityState, networkStatus?.peerCount)}
          leading={(
            <span className="relative shrink-0">
              <Tile icon="hub" />
              <StatusDot state={connectivityState} />
            </span>
          )}
          onClick={onOpenNetworkStatus}
        />
        {backup && (
          <ActionRow
            label={t('settings.backup')}
            desc={summaryText(backup, t)}
            leading={(
              <span className="relative shrink-0">
                <Tile icon="shield" />
                {lamp && <ProtectionDot lamp={lamp} />}
              </span>
            )}
            onClick={onOpenBackup}
          />
        )}
        <ActionRow
          icon="history"
          label={t('settings.activityLog')}
          desc={activityDesc(t, auditConfig ?? null, auditStats ?? null)}
          onClick={onOpenActivityLog}
        />
      </div>
    </section>
  )
}

// A staged update names its own version; every other summary follows the running one.
function aboutDesc(t: TFunction, label: string, status: UpdateStatus): string {
  const key = updateSummaryKey(status)
  if (!key) return label
  if (status.state === UPDATE_STATE.READY) return t(key, { version: status.nextVersion })
  return `${label} · ${t(key)}`
}

function AppGroup({ onOpenAbout, onFeedback }: Pick<AccountProps, 'onOpenAbout' | 'onFeedback'>) {
  const { t } = useTranslation()
  const { openCheatsheet } = useKeyboard()
  const { status } = useUpdates()
  const { label } = useAppBuild()
  const dot = updateDot(status)

  return (
    <section>
      <SectionHeading>{t('account.groupApp')}</SectionHeading>
      <div className={ROW_GROUP}>
        <ActionRow
          label={t('about.title')}
          desc={aboutDesc(t, label, status)}
          leading={(
            <span className="relative shrink-0">
              <Tile icon="info" />
              {dot && <UpdateDot lamp={dot} />}
            </span>
          )}
          onClick={onOpenAbout}
        />
        <ActionRow
          icon="keyboard"
          label={t('aboutSettings.keyboardShortcuts')}
          desc={t('aboutSettings.keyboardShortcutsDesc')}
          onClick={openCheatsheet}
        />
        <LinkRow
          icon="menu_book"
          label={t('aboutSettings.documentation')}
          desc={t('aboutSettings.documentationDesc')}
          href="https://mirall.app/docs"
        />
        <ActionRow
          icon="feedback"
          label={t('aboutSettings.sendFeedback')}
          desc={t('aboutSettings.sendFeedbackDesc')}
          onClick={onFeedback}
        />
      </div>
    </section>
  )
}

export default function Account({ profile, onSave, onBack, onOpenNetworkStatus, onOpenActivityLog, onOpenBackup, onOpenAbout, onFeedback }: AccountProps) {
  const { t } = useTranslation()
  const { ref, hasOverflow } = useHasVerticalOverflow<HTMLDivElement>()

  return (
    <div
      ref={ref}
      className={`relative h-[calc(100vh-5.5rem-var(--banner-h,0px))] overflow-y-auto scrollbar-thin pb-8 mr-2 ${hasOverflow ? 'pr-4' : ''}`}
    >
      <div className="pt-8 px-8 max-w-2xl mx-auto">
        <PageHeader
          title={t('account.title')}
          subtitle={t('account.intro')}
          onBack={onBack}
        />

        <div className="space-y-10">
          <section>
            <ProfileCard profile={profile} onSave={onSave} />
          </section>
          <DeviceGroup onOpenNetworkStatus={onOpenNetworkStatus} onOpenActivityLog={onOpenActivityLog} onOpenBackup={onOpenBackup} />
          <AppGroup onOpenAbout={onOpenAbout} onFeedback={onFeedback} />
        </div>
      </div>
    </div>
  )
}
