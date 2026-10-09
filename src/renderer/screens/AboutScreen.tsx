// About Mirall: the running build and whether it is current, the details a support request needs,
// and the project's links and legal pages.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { UPDATE_STATE, UPDATES_OFF_REASON, type UpdateStatus } from '../../shared/contract/update-status.js'
import { appInfoLine, archLabel, osLabel } from '../model/about-view.js'
import { useHasVerticalOverflow } from '../hooks/useHasVerticalOverflow.js'
import { useUpdates } from '../hooks/useUpdates.js'
import { useAppBuild } from '../hooks/useAppBuild.js'
import { useOpenWhatsNew } from '../hooks/useOpenWhatsNew.js'
import { useRunAction } from '../hooks/useRunAction.js'
import { useClipboardCopy } from '../hooks/useClipboardCopy.js'
import { checkForUpdate, restartToUpdate } from '../platform/updates.js'
import PageHeader from '../components/layout/PageHeader.js'
import SectionHeading from '../components/layout/SectionHeading.js'
import ActionRow, { LinkRow, ROW_GROUP } from '../components/layout/ActionRow.js'
import { Section, Field } from '../components/network/StatusRows.js'
import UpdateVerdictBanner from '../components/about/UpdateVerdictBanner.js'
import Logo from '../components/primitives/Logo.js'
import Badge from '../components/primitives/Badge.js'
import Button from '../components/primitives/Button.js'
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
    <section className="bg-surface-container-low rounded-xl p-6 flex items-center gap-6">
      <div className="flex-1 min-w-0">
        <Logo className="h-16 w-auto text-accent" label="Mirall" />
        <p className="text-sm text-on-surface-variant mt-3">{t('about.tagline')}</p>
      </div>
      <div className="shrink-0 flex flex-col items-end gap-2">
        <div className="flex items-center gap-2">
          <p className="font-semibold text-accent">{build.label}</p>
          <CopyButton value={`Mirall ${build.label}`} />
        </div>
        {build.channel !== 'release' && (
          <Badge label={t(`about.badge.${build.channel}`)} classes="bg-secondary-container text-on-secondary-container" />
        )}
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

function updatesMethodKey(status: UpdateStatus): string {
  if (status.state !== UPDATE_STATE.OFF) return 'about.updatesMethod.auto'
  return status.offReason === UPDATES_OFF_REASON.DEB_INSTALL ? 'about.updatesMethod.packageManager' : 'about.updatesMethod.off'
}

function DetailsSection({ status }: { status: UpdateStatus }) {
  const { t } = useTranslation()
  const build = useAppBuild()
  const [system] = useState(() => window.bridge.getSystemInfo())
  const { copied, copy } = useClipboardCopy()

  return (
    <Section title={t('about.details')}>
      <Field label={t('about.field.version')} value={build.label} copyValue={build.label} />
      <Field label={t('about.field.channel')} value={t(`about.channel.${build.channel}`)} />
      <Field label={t('about.field.installedOn')} value={`${osLabel(system)} · ${archLabel(system)}`} />
      <Field label={t('about.field.updates')} value={t(updatesMethodKey(status))} />
      <div className="px-6 py-4 flex justify-center">
        <Button variant="secondary" icon={copied ? 'check' : 'content_copy'} onClick={() => copy(appInfoLine(build.label, system))}>
          {copied ? t('actions.copied') : t('about.copyInfo')}
        </Button>
        <span role="status" aria-live="polite" className="sr-only">{copied ? t('actions.copied') : ''}</span>
      </div>
    </Section>
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
          <DetailsSection status={status} />
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
