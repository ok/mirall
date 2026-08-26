import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useConnectionStatus } from '../hooks/useConnectionStatus.js'
import { useHasVerticalOverflow } from '../hooks/useHasVerticalOverflow.js'
import { fixStepsFor } from '../connectivity.js'
import Button from '../components/primitives/Button.js'
import Icon from '../components/primitives/Icon.js'
import PageHeader from '../components/layout/PageHeader.js'

interface Props {
  onBack?: () => void
  onContinue: () => void
  onShowDetails: () => void
  onShowHistory: () => void
}

function relativeCheck(at: number, now: number, t: (key: string, opts?: Record<string, unknown>) => string): string {
  if (!at) return t('connectionProblem.checkedNever')
  const minutes = Math.floor(Math.max(0, now - at) / 60000)
  if (minutes < 1) return t('connectionProblem.checkedJustNow')
  return t('connectionProblem.checkedMinutes', { count: minutes })
}

export default function ConnectionProblem({ onBack, onContinue, onShowDetails, onShowHistory }: Props) {
  const { t } = useTranslation()
  const { status, reachability, probeCanary } = useConnectionStatus()
  const { ref, hasOverflow } = useHasVerticalOverflow<HTMLDivElement>()
  const headingRef = useRef<HTMLHeadingElement>(null)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  const handleCheckAgain = useCallback(async () => {
    if (checking) return
    setChecking(true)
    try {
      await probeCanary({ force: true })
    } finally {
      setChecking(false)
    }
  }, [checking, probeCanary])

  const verdict = reachability?.verdict
  const degraded = verdict === 'blocked' || verdict === 'at-risk'
  const blocked = verdict === 'blocked'
  const cause = reachability?.cause ?? 'generic'
  // Being offline is not the same as being blocked, and must not read like it.
  const offline = cause === 'os-offline'
  // We cannot prove the VPN is at fault, so the wording stays "can't reach" rather than
  // "your network is blocking" — but the advice leads with the likeliest culprit.
  const vpnOnly = cause === 'vpn-only-route'
  const tone = offline ? 'offline' : vpnOnly ? 'vpnOnly' : blocked ? 'blocked' : 'atRisk'
  const steps = fixStepsFor(reachability?.cause ?? null)

  return (
    <div
      ref={ref}
      className={`h-[calc(100vh-5.5rem-var(--banner-h,0px))] overflow-y-auto scrollbar-thin pb-8 mr-2 ${hasOverflow ? 'pr-4' : ''}`}
    >
      <div className="pt-10 px-8 max-w-2xl mx-auto">
        <PageHeader
          title={degraded ? t(`connectionProblem.heading.${tone}`) : t('connectionProblem.recoveredTitle')}
          subtitle={degraded
            ? t(`connectionProblem.subtitle.${tone}`)
            : t('connectionProblem.recoveredSubtitle')}
          onBack={onBack}
          headingRef={headingRef}
        />

        {!degraded && (
          <div className="bg-surface-container-low rounded-xl p-6 flex items-start gap-5">
            <span aria-hidden="true" className="w-4 h-4 rounded-full shrink-0 mt-1.5 bg-online ring-4 ring-online/25" />
            <div className="flex-1 min-w-0">
              <p role="status" aria-live="polite" className="text-2xl font-headline font-bold text-accent">
                {t('connectionProblem.recoveredVerdict')}
              </p>
              <p className="text-sm text-on-surface-variant mt-2 leading-relaxed">
                {t('connectionProblem.recoveredBody')}
              </p>
              <div className="mt-5">
                <Button onClick={onContinue}>{t('connectionProblem.continueToSpaces')}</Button>
              </div>
            </div>
          </div>
        )}

        {degraded && (
        <div className="space-y-6">
          <div className="bg-surface-container-low rounded-xl p-6 flex items-start gap-5">
            <span
              aria-hidden="true"
              className={`w-4 h-4 rounded-full shrink-0 mt-1.5 ring-4 ${
                blocked ? 'bg-error ring-error/25' : 'bg-secondary-container ring-secondary-container/30'
              }`}
            />
            <div className="flex-1 min-w-0">
              <p role="status" aria-live="polite" className="text-2xl font-headline font-bold text-accent">
                {t(`connectionProblem.verdict.${tone}`)}
              </p>
              <p className="text-sm text-on-surface-variant mt-2 leading-relaxed">
                {t(`connectionProblem.body.${cause}`, { defaultValue: t('connectionProblem.body.generic') })}
              </p>
            </div>
          </div>

          <section>
            <h2 className="text-xl font-headline font-bold text-accent mb-4">
              {t('connectionProblem.fixHeading')}
            </h2>
            <ol className="bg-surface-container-low rounded-xl p-6 space-y-5">
              {steps.map((step, index) => (
                <li key={step} className="flex items-start gap-4">
                  <span
                    aria-hidden="true"
                    className="shrink-0 w-7 h-7 rounded-full bg-primary text-on-primary font-headline font-bold text-sm flex items-center justify-center"
                  >
                    {index + 1}
                  </span>
                  <span className="text-sm text-on-surface leading-relaxed pt-0.5">
                    {t(`connectivity.fix.${step}`)}
                  </span>
                </li>
              ))}
            </ol>
          </section>

          <div className="flex items-center gap-3 flex-wrap">
            <Button icon="refresh" onClick={handleCheckAgain} disabled={checking}>
              {checking ? t('connectionProblem.checking') : t('connectionProblem.checkAgain')}
            </Button>
            <Button variant="secondary" onClick={onShowDetails}>
              {t('connectionProblem.networkDetails')}
            </Button>
            <Button variant="secondary" onClick={onShowHistory}>
              {t('connectionProblem.connectionHistory')}
            </Button>
            <span className="text-xs text-on-surface-variant ml-auto">
              {relativeCheck(status?.canary?.at ?? 0, Date.now(), t)}
            </span>
          </div>

          <div className="rounded-xl bg-surface-container-lowest p-5 flex items-start gap-3">
            <Icon name="info" size={20} className="shrink-0 text-on-surface-variant mt-0.5" />
            <p className="text-sm text-on-surface-variant leading-relaxed">
              {t(`connectionProblem.stillWorks.${tone}`)}
              <button
                type="button"
                onClick={onContinue}
                className="font-bold text-accent underline underline-offset-2 ml-1 rounded-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30"
              >
                {t('connectionProblem.continueToSpaces')}
              </button>
            </p>
          </div>
        </div>
        )}
      </div>
    </div>
  )
}
