// First-run screen: create the local profile (display name + optional avatar).
import { useState, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { resizeAvatar, NAME_MAX, AVATAR_INPUT_MAX_BYTES } from '../utils.js'
import Icon from '../components/primitives/Icon.js'
import Avatar from '../components/primitives/Avatar.js'
import Button from '../components/primitives/Button.js'
import Logo from '../components/primitives/Logo.js'

interface OnboardingProps {
  onComplete: (data: { displayName: string; avatar: string | null }) => Promise<unknown>
}

export default function Onboarding({ onComplete }: OnboardingProps) {
  const { t } = useTranslation()
  const [displayName, setDisplayName] = useState('')
  const [avatar, setAvatar] = useState<string | null>(null)
  const [avatarError, setAvatarError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  async function handleContinue() {
    if (!displayName.trim()) return
    await onComplete({ displayName: displayName.trim(), avatar })
  }

  function handleAvatarClick() {
    fileRef.current?.click()
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
    <div className="min-h-screen flex flex-col">
      <header className="fixed top-0 w-full z-50" style={{ WebkitAppRegion: 'drag' }}>
        <div className="bg-surface-container-lowest/70 backdrop-blur-xl shadow-[0_12px_40px_rgba(74,59,82,0.06)]">
          <div className="flex items-center justify-center py-4 px-8 w-full max-w-7xl mx-auto">
            <span className="flex h-8 items-center text-on-surface">
              <Logo label="Mirall" />
            </span>
          </div>
        </div>
      </header>

      <main className="flex-grow flex flex-col items-center justify-center px-8 pt-24 pb-12">
        <div className="w-full max-w-md">
          <div className="mb-10 text-center md:text-left">
            <h1 className="text-4xl md:text-5xl font-headline font-extrabold text-accent tracking-tight mb-4">
              {t('onboarding.welcome')}
            </h1>
            <p className="text-lg text-on-surface-variant leading-relaxed">
              {t('onboarding.intro')}
            </p>
          </div>

          <div className="bg-surface-container-low rounded-2xl p-8 space-y-8 shadow-[0_12px_40px_rgba(74,59,82,0.04)]">
            <div className="flex justify-center md:justify-start">
              <button
                type="button"
                onClick={handleAvatarClick}
                aria-label={t('settings.changeAvatar')}
                className="relative w-20 h-20 rounded-full bg-surface flex items-center justify-center shadow-xl cursor-pointer overflow-hidden p-0 border-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30"
              >
                <Avatar src={avatar} size="xl" fallback="silhouette" decorative />
                <div className={`absolute inset-0 bg-black/20 flex items-center justify-center transition-opacity ${avatar ? 'opacity-0 hover:opacity-100' : 'opacity-100'}`}>
                  <Icon name="edit" size={20} className="text-white" />
                </div>
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleAvatarChange}
              />
            </div>
            {avatarError && (
              <p role="alert" className="text-xs text-error px-1 -mt-4">{avatarError}</p>
            )}

            <div className="space-y-2">
              <label className="block text-sm font-semibold text-accent px-1" htmlFor="display-name">
                {t('onboarding.displayName')}
              </label>
              <input
                id="display-name"
                type="text"
                maxLength={NAME_MAX}
                aria-describedby="display-name-count"
                className="w-full bg-surface-container-lowest border-none rounded-xl px-4 py-4 text-on-surface placeholder:text-outline-variant focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30 transition-all text-lg"
                placeholder={t('onboarding.displayNamePlaceholder')}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleContinue()}
              />
              <p className="text-xs text-on-surface-variant px-1">
                {t('onboarding.displayNameHelp')}
              </p>
              <p id="display-name-count" className="text-xs text-on-surface-variant px-1" aria-live="polite">
                {t('settings.displayNameCount', { count: displayName.length, max: NAME_MAX })}
              </p>
            </div>

            <div className="pt-4">
              <Button size="lg" fullWidth onClick={handleContinue} disabled={!displayName.trim()}>
                {t('actions.continue')}
                <Icon name="arrow_forward" />
              </Button>
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}
