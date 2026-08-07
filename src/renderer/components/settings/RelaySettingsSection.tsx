// Relays section of Settings ▸ Network. Rendered only when the `relay` feature flag is
// on; the surrounding screen belongs to the bandwidth-controls workstream.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { request } from '../../ipc.js'
import { getRelayMode, getRelays, persistRelayConfig, type RelayEntry, type RelayMode } from '../../config-client.js'
import { newRelayId, truncateRelayKey } from '../../relay-key.js'
import Badge from '../primitives/Badge.js'
import Button from '../primitives/Button.js'
import CopyButton from '../primitives/CopyButton.js'
import Icon from '../primitives/Icon.js'
import SectionHeading from '../layout/SectionHeading.js'
import { CompactToggle } from '../primitives/Toggle.js'
import AddRelayModal from '../modals/AddRelayModal.js'

const MODES: RelayMode[] = ['off', 'auto', 'always']

interface RelayTestResult {
  ok: boolean
  reason?: string
}

function verdictBadge(relay: RelayEntry, testing: boolean, t: (key: string) => string) {
  if (testing) return <Badge label={t('networkSettings.relays.testing')} classes="bg-surface-container-high text-on-surface-variant" />
  if (!relay.lastTest) return <Badge label={t('networkSettings.relays.notTested')} classes="bg-surface-container-high text-on-surface-variant" />
  return relay.lastTest.ok
    ? <Badge label={t('networkSettings.relays.reachable')} classes="bg-primary/15 text-accent" />
    : <Badge label={t('networkSettings.relays.unreachable')} classes="bg-error-container text-on-error-container" />
}

export default function RelaySettingsSection() {
  const { t } = useTranslation()
  const [mode, setMode] = useState<RelayMode>(getRelayMode)
  const [relays, setRelayList] = useState<RelayEntry[]>(getRelays)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)

  // A probe runs for up to ten seconds, and the user can toggle or remove a relay
  // while it does. Handlers read the live values through these refs, so a verdict
  // arriving late merges into the current list instead of resurrecting a stale one.
  const latest = useRef({ mode, relays })
  // A probe outlives the screen: ScreenRouter unmounts this on navigation, and a verdict
  // resolving afterwards would commit this instance's stale list — re-persisting relays
  // deleted in the meantime and reinstalling their keys on both swarms.
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  // Persist first, then tell the worker: a crash between the two leaves the durable
  // config correct and the worker re-reads it from the boot frame on respawn.
  const commit = useCallback((nextMode: RelayMode, nextRelays: RelayEntry[]) => {
    latest.current = { mode: nextMode, relays: nextRelays }
    setRelayList(nextRelays)
    setMode(nextMode)
    // main sanitizes on write (dedupe, cap, label length), so adopt what it actually
    // stored rather than leaving the optimistic array on screen — otherwise rows main
    // dropped keep rendering as configured until the next launch.
    persistRelayConfig(nextMode, nextRelays).then((stored) => {
      if (!alive.current) return
      latest.current = { mode: nextMode, relays: stored }
      setRelayList(stored)
      return request('network:set-relays', { relayMode: nextMode, relays: stored })
    }).catch((err) => console.error('relay config push failed:', err))
  }, [])

  // Adding the first relay while the mode is still 'off' would configure a relay that
  // does nothing, so the first add opts into the library default. Later adds respect
  // whatever the user has since chosen.
  const handleAdd = useCallback((publicKey: string, label: string) => {
    const entry: RelayEntry = { id: newRelayId(), label, publicKey, enabled: true, lastTest: null }
    const { mode: current, relays: existing } = latest.current
    const nextMode = existing.length === 0 && current === 'off' ? 'auto' : current
    commit(nextMode, [...existing, entry])
  }, [commit])

  const handleRemove = useCallback((id: string) => {
    commit(latest.current.mode, latest.current.relays.filter((r) => r.id !== id))
  }, [commit])

  const handleToggle = useCallback((id: string, enabled: boolean) => {
    commit(latest.current.mode, latest.current.relays.map((r) => (r.id === id ? { ...r, enabled } : r)))
  }, [commit])

  const handleTest = useCallback(async (relay: RelayEntry) => {
    setTestingId(relay.id)
    let ok = false
    try {
      const result = await request('network:test-relay', { publicKey: relay.publicKey }) as RelayTestResult
      ok = result?.ok === true
    } catch (err) {
      console.error('relay test failed:', err)
    }
    if (!alive.current) return
    setTestingId(null)
    const verdict = { at: Date.now(), ok }
    const { mode: liveMode, relays: liveRelays } = latest.current
    // Removed mid-probe? Then there is nothing to record.
    if (!liveRelays.some((r) => r.id === relay.id)) return
    commit(liveMode, liveRelays.map((r) => (r.id === relay.id ? { ...r, lastTest: verdict } : r)))
  }, [commit])

  return (
    <section>
      <SectionHeading>{t('networkSettings.relays.heading')}</SectionHeading>
      <div className="bg-surface-container-low rounded-xl p-6 space-y-6">
        <p className="text-sm text-on-surface-variant">{t('networkSettings.relays.desc')}</p>

        {relays.length > 0 && (
          <div className="flex items-center justify-between">
            <p className="font-semibold text-accent">{t('networkSettings.relays.modeLabel')}</p>
            <div className="flex bg-surface-container-high dark:bg-surface-container-highest p-1 rounded-full">
              {MODES.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => commit(option, latest.current.relays)}
                  aria-label={t(`networkSettings.relays.mode.${option}`)}
                  aria-pressed={mode === option}
                  className={`px-4 py-2 rounded-full text-sm transition-all active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30 ${
                    mode === option ? 'bg-surface-container-lowest shadow-sm text-accent font-semibold' : 'text-on-surface-variant hover:text-accent font-medium'
                  }`}
                >
                  {t(`networkSettings.relays.mode.${option}`)}
                </button>
              ))}
            </div>
          </div>
        )}

        {mode === 'always' && relays.length > 0 && (
          <p className="rounded-xl bg-surface-container-high px-5 py-3 text-sm text-on-surface-variant" role="status">
            {t('networkSettings.relays.alwaysWarning')}
          </p>
        )}

        {relays.length === 0
          ? <p className="text-sm text-on-surface-variant">{t('networkSettings.relays.empty')}</p>
          : (
            <ul className="space-y-3">
              {relays.map((relay) => (
                <li key={relay.id} className="flex items-center gap-3 bg-surface-container-high/40 rounded-xl px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-accent truncate">{relay.label || t('networkSettings.relays.unnamed')}</p>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-on-surface-variant truncate">{truncateRelayKey(relay.publicKey)}</span>
                      <CopyButton value={relay.publicKey} />
                    </div>
                  </div>
                  {verdictBadge(relay, testingId === relay.id, t)}
                  <button
                    type="button"
                    onClick={() => handleTest(relay)}
                    disabled={testingId !== null}
                    aria-label={t('networkSettings.relays.testAction', { name: relay.label || relay.publicKey })}
                    className="shrink-0 rounded-lg px-3 py-1.5 text-sm font-semibold text-accent hover:bg-surface-container-highest disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30"
                  >
                    {t('networkSettings.relays.test')}
                  </button>
                  <CompactToggle
                    ariaLabel={t('networkSettings.relays.useAction', { name: relay.label || relay.publicKey })}
                    checked={relay.enabled}
                    onChange={(next) => handleToggle(relay.id, next)}
                  />
                  <button
                    type="button"
                    onClick={() => handleRemove(relay.id)}
                    aria-label={t('networkSettings.relays.removeAction', { name: relay.label || relay.publicKey })}
                    className="shrink-0 rounded-lg p-1.5 text-on-surface-variant hover:bg-error-container hover:text-on-error-container focus:outline-none focus-visible:ring-2 focus-visible:ring-error/30"
                  >
                    <Icon name="delete" size={18} />
                  </button>
                </li>
              ))}
            </ul>
          )}

        <Button onClick={() => setAddOpen(true)} ariaLabel={t('networkSettings.relays.addAction')}>
          {t('networkSettings.relays.addAction')}
          <Icon name="add_circle" />
        </Button>
      </div>

      <AddRelayModal isOpen={addOpen} onClose={() => setAddOpen(false)} onAdd={handleAdd} />
    </section>
  )
}
