// About Mirall: the running build and whether it is current, and the project's links and legal pages.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { UpdateStatus } from '../../shared/contract/update-status.js'
import { useHasVerticalOverflow } from '../hooks/useHasVerticalOverflow.js'
import { useUpdates } from '../hooks/useUpdates.js'
import { useAppBuild } from '../hooks/useAppBuild.js'
import { useOpenWhatsNew } from '../hooks/useOpenWhatsNew.js'
import { useRunAction } from '../hooks/useRunAction.js'
import { checkForUpdate, restartToUpdate } from '../platform/updates.js'
import PageHeader from '../components/layout/PageHeader.js'
import SectionHeading from '../components/layout/SectionHeading.js'
import ActionRow, { LinkRow, ROW_GROUP } from '../components/layout/ActionRow.js'
import UpdateVerdictBanner from '../components/about/UpdateVerdictBanner.js'
import Logo from '../components/primitives/Logo.js'
import Badge from '../components/primitives/Badge.js'
import CopyButton from '../components/primitives/CopyButton.js'

const LINKS = {
  website: 'https://mirall.app',
  support: 'https://mirall.app/support',
  source: 'https://github.com/ok/mirall',
  security: 'https://github.com/ok/mirall/security/policy',
  privacy: 'https://mirall.app/privacy',
  legalNotice: 'https://mirall.app/impressum',
  license: 'https://github.com/ok/mirall/blob/main/LICENSE',
} as const

interface AboutScreenProps {
  onBack: () => void
}

function IdentityCard() {
  const { t } = useTranslation()
  const build = useAppBuild()
  return (
    <section className="bg-surface-container-low rounded-xl p-6 flex items-end justify-between gap-6">
      <div className="min-w-0">
        <Logo className="h-16 w-auto text-accent" label="Mirall" />
        <p className="text-sm text-on-surface-variant mt-3">{t('about.tagline')}</p>
      </div>
      <div className="shrink-0 flex flex-col items-end gap-2">
        {build.channel !== 'release' && (
          <Badge label={t(`about.badge.${build.channel}`)} classes="bg-secondary-container text-on-secondary-container" />
        )}
        <div className="flex items-center gap-2">
          <p className="text-sm text-on-surface-variant">{build.label}</p>
          <CopyButton value={`Mirall ${build.label}`} />
        </div>
      </div>
    </section>
  )
}

function UpdatesSection({ status }: { status: UpdateStatus }) {
  const { t } = useTranslation()
  const runAction = useRunAction()
  const [restarting, setRestarting] = useState(false)

  function handleRestart() {
    setRestarting(true)
    runAction(async () => {
      try {
        if (!(await restartToUpdate())) setRestarting(false)
      } catch (err) {
        setRestarting(false)
        throw err
      }
    })
  }

  return (
    <section>
      <SectionHeading>{t('about.updates')}</SectionHeading>
      <UpdateVerdictBanner
        status={status}
        restarting={restarting}
        onCheck={() => runAction(checkForUpdate)}
        onRestart={handleRestart}
      />
    </section>
  )
}

function ProjectSection() {
  const { t } = useTranslation()
  const openWhatsNew = useOpenWhatsNew()
  return (
    <section>
      <SectionHeading>{t('about.groupProject')}</SectionHeading>
      <div className={ROW_GROUP}>
        <ActionRow icon="auto_awesome" label={t('aboutSettings.whatsNew')} desc={t('aboutSettings.whatsNewDesc')} onClick={openWhatsNew} />
        <LinkRow icon="computer" label={t('about.website')} desc="mirall.app" href={LINKS.website} />
        <LinkRow icon="feedback" label={t('about.support')} desc={t('about.supportDesc')} href={LINKS.support} />
        <LinkRow icon="code" label={t('about.source')} desc={t('about.sourceDesc')} href={LINKS.source} />
        <LinkRow icon="shield" label={t('about.security')} desc={t('about.securityDesc')} href={LINKS.security} />
      </div>
    </section>
  )
}

function LegalSection() {
  const { t } = useTranslation()
  return (
    <section>
      <SectionHeading>{t('about.groupLegal')}</SectionHeading>
      <div className={ROW_GROUP}>
        <LinkRow icon="lock" label={t('about.privacy')} desc={t('about.privacyDesc')} href={LINKS.privacy} />
        <LinkRow icon="description" label={t('about.legalNotice')} desc={t('about.legalNoticeDesc')} href={LINKS.legalNotice} />
        <LinkRow icon="data_object" label={t('about.license')} desc={t('about.licenseDesc')} href={LINKS.license} />
      </div>
    </section>
  )
}

export default function AboutScreen({ onBack }: AboutScreenProps) {
  const { t } = useTranslation()
  const { ref, hasOverflow } = useHasVerticalOverflow<HTMLDivElement>()
  const { status } = useUpdates()

  return (
    <div
      ref={ref}
      className={`relative h-[calc(100vh-5.5rem-var(--banner-h,0px))] overflow-y-auto scrollbar-thin pb-8 mr-2 ${hasOverflow ? 'pr-4' : ''}`}
    >
      <div className="pt-8 px-8 max-w-2xl mx-auto">
        <PageHeader title={t('about.title')} subtitle={t('about.intro')} onBack={onBack} />
        <div className="space-y-10">
          <IdentityCard />
          <UpdatesSection status={status} />
          <ProjectSection />
          <LegalSection />
          <footer className="text-center text-xs text-on-surface-variant space-y-1">
            <p>{t('about.madeBy')}</p>
            <p>{t('about.copyright', { year: new Date().getFullYear() })}</p>
          </footer>
        </div>
      </div>
    </div>
  )
}
