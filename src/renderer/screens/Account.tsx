// Account screen: edit display name and avatar, view the identity-protection level, and reach network status.
import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { resizeAvatar, NAME_MAX, AVATAR_INPUT_MAX_BYTES } from '../utils.js'
import type { Profile } from '../types.js'
import type { IdentityProtection } from '../global.js'
import { useHasVerticalOverflow } from '../hooks/useHasVerticalOverflow.js'
import { useConnectionStatus } from '../hooks/useConnectionStatus.js'
import NetworkStatusIndicator from '../components/widgets/NetworkStatusIndicator.js'
import Icon, { type IconName } from '../components/primitives/Icon.js'
import Avatar from '../components/primitives/Avatar.js'
import PageHeader from '../components/layout/PageHeader.js'
import SectionHeading from '../components/layout/SectionHeading.js'

interface AccountProps {
  profile: Profile | null
  onSave: (data: { displayName: string; avatar: string | null }) => Promise<unknown>
  onBack: () => void
  onOpenNetworkStatus: () => void
}

export default function Account({ profile, onSave, onBack, onOpenNetworkStatus }: AccountProps) {
  const { t } = useTranslation()
  const [displayName, setDisplayName] = useState(profile?.displayName || '')
  const [avatar, setAvatar] = useState<string | null>(profile?.avatar || null)
  const [saving, setSaving] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const { state: connectivityState, status: networkStatus } = useConnectionStatus()
  const { ref, hasOverflow } = useHasVerticalOverflow<HTMLDivElement>()
  const [identity, setIdentity] = useState<IdentityProtection | null>(null)
  const [avatarError, setAvatarError] = useState<string | null>(null)

  useEffect(() => {
    window.bridge.getIdentityProtection().then(setIdentity).catch(() => {})
  }, [])

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

  const hasChanges = displayName !== profile?.displayName || avatar !== profile?.avatar

  const identityLine: Record<IdentityProtection, { icon: IconName; key: string }> = {
    protected: { icon: 'shield', key: 'settings.identityProtected' },
    weak: { icon: 'info', key: 'settings.identityWeak' },
    disabled: { icon: 'info', key: 'settings.identityDisabled' },
  }

  return (
    <div
      ref={ref}
      className={`h-[calc(100vh-5.5rem-var(--banner-h,0px))] overflow-y-auto scrollbar-thin pb-8 mr-2 ${hasOverflow ? 'pr-4' : ''}`}
    >
      <div className="pt-8 px-8 max-w-2xl mx-auto">
        <PageHeader
          title={t('account.title')}
          subtitle={t('account.intro')}
          onBack={onBack}
        />

        <div className="space-y-10">
          <section>
            <SectionHeading>{t('settings.profile')}</SectionHeading>
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
          </section>

          {identity && (
            <section>
              <SectionHeading>{t('settings.security')}</SectionHeading>
              <div className="bg-surface-container-low rounded-xl p-6 flex items-center gap-4">
                <div className="w-10 h-10 rounded-full bg-icon-tile flex items-center justify-center text-on-icon-tile">
                  <Icon name={identityLine[identity].icon} />
                </div>
                <p className="text-sm text-on-surface-variant flex-1 min-w-0">{t(identityLine[identity].key)}</p>
              </div>
            </section>
          )}

          <section>
            <SectionHeading>{t('settings.networkStatus')}</SectionHeading>
            <button
              type="button"
              onClick={onOpenNetworkStatus}
              aria-label={t('settings.networkStatus')}
              className="w-full bg-surface-container-low rounded-xl p-6 flex items-center gap-4 text-left hover:bg-surface-container-high/50 active:scale-[0.99] transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30 cursor-pointer"
            >
              <NetworkStatusIndicator state={connectivityState} size="lg" />
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-accent">{t(`connectivity.${connectivityState}`)}</p>
                <p className="text-xs text-on-surface-variant">
                  {t('settings.networkStatusDesc', { count: networkStatus?.peerCount ?? 0 })}
                </p>
              </div>
              <Icon name="chevron_right" className="text-secondary" />
            </button>
          </section>
        </div>
      </div>
    </div>
  )
}
