// Profile screen: edit display name and avatar; this device's connection, identity protection and
// activity log; app version and resources (absorbed from the former About screen).
import { useState, useRef, useEffect, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { resizeAvatar, NAME_MAX, AVATAR_INPUT_MAX_BYTES } from '../utils.js'
import { request } from '../ipc.js'
import { connectionDesc, activityDesc } from '../profileRows.js'
import type { AuditConfig, AuditStats, Profile } from '../types.js'
import type { IdentityProtection } from '../global.js'
import { useHasVerticalOverflow } from '../hooks/useHasVerticalOverflow.js'
import { useConnectionStatus } from '../hooks/useConnectionStatus.js'
import { useUpdates } from '../hooks/useUpdates.js'
import { useKeyboard } from '../keyboard/KeyboardProvider.js'
import { loadAllEntries } from '../changelog.js'
import * as whatsNew from '../whats-new.js'
import NetworkStatusIndicator from '../components/widgets/NetworkStatusIndicator.js'
import Icon, { type IconName } from '../components/primitives/Icon.js'
import Avatar from '../components/primitives/Avatar.js'
import CopyButton from '../components/primitives/CopyButton.js'
import PageHeader from '../components/layout/PageHeader.js'
import SectionHeading from '../components/layout/SectionHeading.js'

interface AccountProps {
  profile: Profile | null
  onSave: (data: { displayName: string; avatar: string | null }) => Promise<unknown>
  onBack: () => void
  onOpenNetworkStatus: () => void
  onOpenActivityLog: () => void
  onFeedback: () => void
}

const GROUP = 'bg-surface-container-low rounded-xl overflow-hidden'
const ROW = 'w-full text-left p-6 flex items-center justify-between hover:bg-surface-container-high/50 active:scale-[0.99] transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-secondary/30 cursor-pointer'

const IDENTITY_LINE: Record<IdentityProtection, { icon: IconName; key: string }> = {
  protected: { icon: 'shield', key: 'settings.identityProtected' },
  weak: { icon: 'info', key: 'settings.identityWeak' },
  disabled: { icon: 'info', key: 'settings.identityDisabled' },
}

function Tile({ icon }: { icon: IconName }) {
  return (
    <div className="w-10 h-10 rounded-full bg-icon-tile flex items-center justify-center text-on-icon-tile shrink-0">
      <Icon name={icon} />
    </div>
  )
}

function RowBody({ leading, title, desc }: { leading: ReactNode; title: string; desc?: ReactNode }) {
  return (
    <div className="flex items-center gap-4 min-w-0">
      {leading}
      <div className="min-w-0">
        <p className="font-semibold text-accent">{title}</p>
        {desc && <p className="text-xs text-on-surface-variant">{desc}</p>}
      </div>
    </div>
  )
}

function ActionRow({ label, desc, icon, leading, onClick }: {
  label: string
  desc?: ReactNode
  icon?: IconName
  leading?: ReactNode
  onClick: () => void
}) {
  return (
    <button type="button" onClick={onClick} aria-label={label} className={ROW}>
      <RowBody leading={leading ?? (icon ? <Tile icon={icon} /> : null)} title={label} desc={desc} />
      <Icon name="chevron_right" className="text-secondary shrink-0" />
    </button>
  )
}

function LinkRow({ label, desc, icon, href }: { label: string; desc: ReactNode; icon: IconName; href: string }) {
  const { t } = useTranslation()
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label={`${label} (${t('a11y.opensExternal')})`}
      className={ROW}
    >
      <RowBody leading={<Tile icon={icon} />} title={label} desc={desc} />
      <Icon name="open_in_new" className="text-secondary shrink-0" />
    </a>
  )
}

// Information, not a control: no role, no focus stop, no chevron.
function InfoRow({ label, desc, icon }: { label: string; desc: ReactNode; icon: IconName }) {
  return (
    <div className="w-full p-6 flex items-center justify-between">
      <RowBody leading={<Tile icon={icon} />} title={label} desc={desc} />
    </div>
  )
}

function ProfileCard({ profile, onSave }: Pick<AccountProps, 'profile' | 'onSave'>) {
  const { t } = useTranslation()
  const [displayName, setDisplayName] = useState(profile?.displayName || '')
  const [avatar, setAvatar] = useState<string | null>(profile?.avatar || null)
  const [saving, setSaving] = useState(false)
  const [avatarError, setAvatarError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const hasChanges = displayName !== profile?.displayName || avatar !== profile?.avatar

  async function handleSave() {
    if (!displayName.trim() || saving) return
    setSaving(true)
    await onSave({ displayName: displayName.trim(), avatar })
    setSaving(false)
  }

  function handleAvatarChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > AVATAR_INPUT_MAX_BYTES) {
      setAvatarError(t('settings.avatarTooLarge'))
      e.target.value = ''
      return
    }
    setAvatarError(null)
    const reader = new FileReader()
    reader.onload = async () => {
      const resized = await resizeAvatar(reader.result as string)
      setAvatar(resized)
    }
    reader.readAsDataURL(file)
  }

  return (
    <div className="bg-surface-container-low rounded-xl p-6 space-y-6">
      <div className="flex items-center gap-6">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          aria-label={t('settings.changeAvatar')}
          className="relative w-20 h-20 rounded-full bg-surface flex items-center justify-center cursor-pointer overflow-hidden shrink-0 p-0 border-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30"
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
            aria-describedby="account-display-name-count"
            className="w-full bg-surface-container-lowest border-none rounded-xl px-4 py-3 text-on-surface placeholder:text-outline-variant focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30 transition-all"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
          <p id="account-display-name-count" className="mt-1 text-xs text-on-surface-variant" aria-live="polite">
            {t('settings.displayNameCount', { count: displayName.length, max: NAME_MAX })}
          </p>
        </div>
      </div>
      {avatarError && (
        <p role="alert" className="text-xs text-error">{avatarError}</p>
      )}
      {hasChanges && (
        <button
          onClick={handleSave}
          disabled={!displayName.trim() || saving}
          className="w-full bg-primary text-on-primary font-bold py-3 rounded-xl hover:opacity-90 active:scale-95 transition-all shadow-lg shadow-primary/10 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30"
        >
          {saving ? t('actions.saving') : t('actions.save')}
        </button>
      )}
    </div>
  )
}

function DeviceGroup({ onOpenNetworkStatus, onOpenActivityLog }: Pick<AccountProps, 'onOpenNetworkStatus' | 'onOpenActivityLog'>) {
  const { t } = useTranslation()
  const { state: connectivityState, status: networkStatus } = useConnectionStatus()
  const [identity, setIdentity] = useState<IdentityProtection | null>(null)
  const [auditConfig, setAuditConfig] = useState<AuditConfig | null>(null)
  const [auditStats, setAuditStats] = useState<AuditStats | null>(null)

  useEffect(() => {
    window.bridge.getIdentityProtection().then(setIdentity).catch(() => {})
  }, [])

  // Read once on mount: this is a summary line, not a live counter — a subscription would repaint
  // the row on every recorded event for no user benefit.
  useEffect(() => {
    let cancelled = false
    Promise.all([
      request('audit:get-config') as Promise<AuditConfig>,
      request('audit:stats') as Promise<AuditStats>,
    ])
      .then(([config, stats]) => {
        if (cancelled) return
        setAuditConfig(config)
        setAuditStats(stats)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  return (
    <section>
      <SectionHeading>{t('account.groupDevice')}</SectionHeading>
      <div className={GROUP}>
        <ActionRow
          label={t('account.connection')}
          desc={connectionDesc(t, connectivityState, networkStatus?.peerCount)}
          leading={(
            <span className="w-10 h-10 flex items-center justify-center shrink-0">
              <NetworkStatusIndicator state={connectivityState} size="lg" />
            </span>
          )}
          onClick={onOpenNetworkStatus}
        />
        {identity && (
          <InfoRow
            icon={IDENTITY_LINE[identity].icon}
            label={t('account.identityTitle')}
            desc={t(IDENTITY_LINE[identity].key)}
          />
        )}
        <ActionRow
          icon="history"
          label={t('settings.activityLog')}
          desc={activityDesc(t, auditConfig, auditStats)}
          onClick={onOpenActivityLog}
        />
      </div>
    </section>
  )
}

function AppGroup({ onFeedback }: Pick<AccountProps, 'onFeedback'>) {
  const { t } = useTranslation()
  const { openCheatsheet } = useKeyboard()
  const { update } = useUpdates()
  const [version, setVersion] = useState('')

  useEffect(() => {
    const sem = window.bridge.pkg().version || '0.0.0'
    // The baked package.json version uniquely identifies the running build on every channel
    // (`-beta.N` = CI run, bare semver = prod tag, `(dev)` = source). Do NOT append appVersion()'s
    // (fork.length): that reads the OTA drive head — the latest length available on the seed — not
    // the version installed here, so it read as a confusing mismatch (e.g. "v1.6.0-beta.82
    // (0.22326)") whenever an update was staged but not yet run.
    setVersion(window.bridge.isDev() ? `v${sem} (dev)` : `v${sem}`)
  }, [])

  // Permanent counterpart to the dismissable banner: while an update is staged this row always says
  // which version is waiting, even after the banner is dismissed.
  const pendingVersion = update
    ? (update.version.semver ?? `${update.version.fork}.${update.version.length}`)
    : null

  async function openWhatsNew() {
    const all = await loadAllEntries()
    if (all.length) whatsNew.open(all, 'all')
  }

  return (
    <section>
      <SectionHeading>{t('account.groupApp')}</SectionHeading>
      <div className={GROUP}>
        <div className="group/copy w-full p-6 flex items-center gap-4">
          <Tile icon="info" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <p className="font-semibold text-accent">Mirall {version || '...'}</p>
              {version && (
                <CopyButton
                  value={`Mirall ${version}`}
                  className="opacity-0 group-hover/copy:opacity-100 focus:opacity-100 transition-opacity"
                />
              )}
            </div>
            {pendingVersion ? (
              <p className="text-xs text-secondary mt-1 flex items-center gap-1">
                <Icon name="update" size={14} />
                {t('aboutSettings.updateReady', { version: pendingVersion })}
              </p>
            ) : (
              <p className="text-xs text-on-surface-variant">{t('account.upToDate')}</p>
            )}
          </div>
        </div>
        <ActionRow
          icon="auto_awesome"
          label={t('aboutSettings.whatsNew')}
          desc={t('aboutSettings.whatsNewDesc')}
          onClick={() => { void openWhatsNew() }}
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

export default function Account({ profile, onSave, onBack, onOpenNetworkStatus, onOpenActivityLog, onFeedback }: AccountProps) {
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
          <DeviceGroup onOpenNetworkStatus={onOpenNetworkStatus} onOpenActivityLog={onOpenActivityLog} />
          <AppGroup onFeedback={onFeedback} />
        </div>
      </div>
    </div>
  )
}
