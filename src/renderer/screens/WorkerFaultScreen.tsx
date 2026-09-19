import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { ChannelFault } from '../ipc/ipc.js'

// The worker is terminally unreachable. Nothing on this screen can fix that, so it offers no action
// that pretends to — and it renders ABOVE the boot gate, because the alternative is onboarding
// opening over an identity the app simply cannot read.
export default function WorkerFaultScreen({ kind }: { kind: ChannelFault }) {
  const { t } = useTranslation()
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  return (
    <main className="min-h-screen bg-surface flex items-center justify-center p-8">
      <div role="alert" className="max-w-md text-center">
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="text-4xl font-headline font-extrabold text-accent tracking-tight focus:outline-none"
        >
          {t(kind === 'protocol' ? 'workerFault.protocolTitle' : 'workerFault.budgetTitle')}
        </h1>
        <p className="mt-4 text-lg text-on-surface-variant leading-relaxed">
          {t(kind === 'protocol' ? 'workerFault.protocolBody' : 'workerFault.budgetBody')}
        </p>
      </div>
    </main>
  )
}
