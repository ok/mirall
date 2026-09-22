// Settings sections live inline in the screen that shows them. A section only becomes its own file
// when it would dominate that screen: this one is 390 lines against settings screens of 56-233. Two
// sections are out here; every other one is inline, and that is the rule, not an accident.
// Relays section of Settings ▸ Network. One slot, taking either a bare relay key (open
// relay) or an invite ticket (private relay).
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ConfirmDestructiveModal from '../../components/modals/ConfirmDestructiveModal.js'
import { request, restartWorker } from '../../ipc/ipc.js'
import { getRelay, getRelayMode, setRelay, type RelayMode, type RelayParseErrorCode, type RelaySlot } from '../../platform/config-client.js'
import { truncateRelayKey } from '../../platform/relay-key.js'
import { isReconnectPending, setReconnectPending } from '../../platform/relay-session.js'
import { rememberScreen } from '../../shell/resume-screen.js'
import Badge from '../../components/primitives/Badge.js'
import Button from '../../components/primitives/Button.js'
import CopyButton from '../../components/primitives/CopyButton.js'
import Icon from '../../components/primitives/Icon.js'
import Toggle from '../../components/primitives/Toggle.js'
import SectionHeading from '../../components/layout/SectionHeading.js'
import ActionMenu from '../../components/primitives/ActionMenu.js'
import DocsLink from '../../components/primitives/DocsLink.js'
import AddRelayModal from '../../components/modals/AddRelayModal.js'
import RelayApplyNotice from '../../components/network/RelayApplyNotice.js'
import { useRelayApply, type RelayApplyResult } from '../../hooks/useRelayApply.js'
import { useRunAction } from '../../hooks/useRunAction.js'
import { relayKindClasses } from '../../model/relay-groups.js'

// A private relay whose seed the running worker has not booted with must not be installed: the
// node still presents its old key, so every dial through it is refused instead of falling back
// to a direct connection. The rest of the config always goes through — a removal or a mode
// change has to reach the worker whether or not an identity is waiting on a restart.
function usableRelay(relay: RelaySlot | null, pendingIdentity: boolean): RelaySlot | null {
  return pendingIdentity && relay?.kind === 'private' ? null : relay
}

function statusOf(relay: RelaySlot, testing: boolean, active: boolean) {
  if (!active || !relay.enabled) return { key: 'disabled', classes: 'bg-surface-container-high text-on-surface-variant' }
  if (testing) return { key: 'testing', classes: 'bg-surface-container-high text-on-surface-variant' }
  if (!relay.lastTest) return { key: 'notTested', classes: 'bg-surface-container-high text-on-surface-variant' }
  if (relay.lastTest.ok) return { key: 'reachable', classes: 'bg-success text-accent' }
  return { key: 'unreachable', classes: 'bg-error-container text-on-error-container' }
}

export default function RelaySettingsSection() {
  const { t } = useTranslation()
  const runAction = useRunAction()
  const [mode, setMode] = useState<RelayMode>(getRelayMode)
  const [relay, setSlot] = useState<RelaySlot | null>(getRelay)
  const [testing, setTesting] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  // Both acts erase the member seed, and neither is recoverable without a new invite, so both
  // are confirmed. An OPEN relay has no seed and a public, re-pasteable key — confirming that
  // would be a nag, which is why Remove already branches on kind.
  const [confirm, setConfirm] = useState<'remove' | 'replace' | null>(null)
  const [reconnectPending, setPending] = useState(isReconnectPending)
  const { notice, reconnecting, arm, apply } = useRelayApply(mode, reconnectPending)

  // A probe runs for up to ten seconds and outlives the screen: ScreenRouter unmounts this on
  // navigation, and a verdict resolving afterwards would commit this instance's stale slot.
  const alive = useRef(true)
  const latest = useRef({ mode, relay })
  const probed = useRef(false)
  const probeGen = useRef(0)
  // Remembers the last non-off mode, so off→on restores an explicit 'always' rather than 'auto'.
  const lastActiveMode = useRef<RelayMode>(mode === 'off' ? 'auto' : mode)
  useEffect(() => () => { alive.current = false }, [])

  const adopt = useCallback((next: { relayMode: RelayMode; relay: RelaySlot | null }) => {
    latest.current = { mode: next.relayMode, relay: next.relay }
    setMode(next.relayMode)
    setSlot(next.relay)
  }, [])

  // Persist first, then tell the worker: a crash between the two leaves the durable config correct
  // and the worker re-reads it from the boot frame on respawn. A change of PINNED identity cannot be
  // applied live (dht.defaultKeyPair is fixed when the node is built) and waits for a reconnect the
  // user asks for; until then the probe honestly reports Unreachable, because the worker really is
  // still presenting its old identity.
  const commit = useCallback(async (payload: Parameters<typeof setRelay>[0]) => {
    const result = await setRelay(payload)
    if (!alive.current || !result.ok) return result
    adopt({ relayMode: result.network.relayMode, relay: result.network.relay })
    if (result.identityChanged) {
      setReconnectPending(true)
      setPending(true)
    }
    const applied = await request('network:set-relay', {
      mode: result.network.relayMode,
      relay: usableRelay(result.network.relay, isReconnectPending()),
      // A reconnect cannot apply a pinned identity, so it would be churn on connections the user is
      // about to lose to the restart anyway.
      deferApply: isReconnectPending(),
    }) as RelayApplyResult | null
    // What the worker DID, not what it found: a change it applied itself needs no notice.
    if (alive.current) arm(applied)
    return result
  }, [adopt, arm])

  // A new relay identity needs a new process: defaultKeyPair is fixed when the DHT node is built,
  // and the seed is read at spawn. Main stops the worker and starts the next one; the window
  // reloads when it reports ready.
  // Not cleared here: the flag is the only affordance for applying the new identity, and a restart
  // that never lands would otherwise take the banner with it. One that does land reloads the
  // window, which resets it anyway.
  const handleReconnect = useCallback(() => {
    // Park this screen first: the reload that follows would otherwise land on the space list, which
    // shows nothing about the relay that was just applied.
    rememberScreen('network-settings')
    runAction(restartWorker)
  }, [runAction])

  const handleTest = useCallback(() => runAction(async () => {
    const target = latest.current.relay
    // Off, or waiting on a restart: the dial would use an identity nothing is applying, so its
    // verdict would be about nothing. statusOf reads Disabled in both cases.
    if (!target || latest.current.mode === 'off' || isReconnectPending()) return
    // A probe runs for up to ten seconds and a second one can start over it. Only the newest
    // owns `testing` and the verdict; an older continuation returns without writing either.
    const gen = ++probeGen.current
    setTesting(true)
    let ok = false
    try {
      const result = await request('network:test-relay', { publicKey: target.publicKey })
      ok = result?.ok === true
    } catch (err) {
      console.error('relay test failed:', err)
    }
    if (!alive.current || gen !== probeGen.current) return
    setTesting(false)
    // Replaced or removed mid-probe? Then there is nothing to record.
    if (latest.current.relay?.publicKey !== target.publicKey) return
    await commit({ mode: latest.current.mode, lastTest: { at: Date.now(), ok } })
  }), [commit, runAction])

  // Adding a relay while the mode is still 'off' would configure something inert, so the add
  // opts into the library default. The probe then runs on its own, so a key nobody serves is
  // caught at configuration time rather than sitting there as "Not tested".
  // Returns the failure to the modal; it must not close on a rejected save.
  const handleAdd = useCallback(async (input: string, label: string): Promise<RelayParseErrorCode | null> => {
    const nextMode = latest.current.mode === 'off' ? 'auto' : latest.current.mode
    try {
      const result = await commit({ mode: nextMode, relay: { input, label } })
      if (!result.ok) return result.code
      if (alive.current) handleTest()
      return null
    } catch (err) {
      console.error('relay add failed:', err)
      return 'save-failed'
    }
  }, [commit, handleTest])

  // Back to 'off': with no relay the mode has nothing to apply to and no control renders it, so
  // carrying 'always' forward would arm the next relay the user adds without asking.
  const handleRemove = useCallback(() => {
    setConfirm(null)
    lastActiveMode.current = 'auto'
    runAction(() => commit({ mode: 'off', relay: null }))
  }, [commit, runAction])

  const handleModeToggle = useCallback((on: boolean) => {
    if (!on && latest.current.mode !== 'off') lastActiveMode.current = latest.current.mode
    runAction(() => commit({ mode: on ? lastActiveMode.current : 'off' }))
  }, [commit, runAction])

  const handleAlwaysToggle = useCallback((on: boolean) => {
    lastActiveMode.current = on ? 'always' : 'auto'
    runAction(() => commit({ mode: lastActiveMode.current }))
  }, [commit, runAction])

  // A slot that has never been probed gets one on mount, so "Not tested" is a state the user
  // passes through rather than one they have to act on.
  useEffect(() => {
    if (probed.current || !relay || relay.lastTest || testing) return
    if (mode === 'off' || reconnectPending) return
    probed.current = true
    handleTest()
  }, [relay, testing, mode, reconnectPending, handleTest])

  const name = relay ? relay.label || relay.publicKey : ''

  return (
    <section>
      <SectionHeading>{t('networkSettings.relays.heading')}</SectionHeading>

      {notice && (
        <RelayApplyNotice
          notice={notice}
          busy={reconnecting}
          onAct={notice === 'restart' ? handleReconnect : apply}
        />
      )}

      {/* One surface: the section's prose and its trailing note live on it, above and below the
          rows, the way the transfer-limits section on this screen keeps its own note. */}
      <div className="bg-surface-container-low rounded-xl overflow-hidden">
        <div className="px-6 pt-6 pb-5">
          <p className="text-sm text-on-surface-variant leading-relaxed">{t('networkSettings.relays.desc')}</p>
          <div className="mt-2">
            <DocsLink target={{ page: 'guides', anchor: 'run-your-own-relay' }} label={t('networkSettings.relays.docsLink')} />
          </div>
        </div>

        {relay ? (
          <>
            <ModeToggles mode={mode} onMode={handleModeToggle} onAlways={handleAlwaysToggle} />
            <RelayRow
              relay={relay}
              testing={testing}
              active={mode !== 'off'}
              canTest={mode !== 'off' && !reconnectPending}
              onTest={handleTest}
              onReplace={() => { if (relay.kind === 'private') setConfirm('replace'); else setAddOpen(true) }}
              onRemove={() => { if (relay.kind === 'private') setConfirm('remove'); else handleRemove() }}
            />
          </>
        ) : (
          <EmptyRelayRow onAdd={() => setAddOpen(true)} />
        )}
      </div>

      <AddRelayModal
        isOpen={addOpen}
        replacing={relay !== null}
        onClose={() => setAddOpen(false)}
        onAdd={handleAdd}
      />

      <ConfirmRelayLossModal
        intent={confirm}
        name={name}
        onClose={() => setConfirm(null)}
        onConfirm={() => { if (confirm === 'remove') handleRemove(); else { setConfirm(null); setAddOpen(true) } }}
      />
    </section>
  )
}

interface ModeTogglesProps {
  mode: RelayMode
  onMode: (on: boolean) => void
  onAlways: (on: boolean) => void
}

function ModeToggles({ mode, onMode, onAlways }: ModeTogglesProps) {
  const { t } = useTranslation()
  return (
    <>
      <div className="border-t border-outline-variant/40">
        <Toggle
          label={t('networkSettings.relays.useRelay')}
          description={t('networkSettings.relays.useRelayDesc')}
          checked={mode !== 'off'}
          onChange={onMode}
        />
      </div>
      <div className="border-t border-outline-variant/40">
        <Toggle
          label={t('networkSettings.relays.alwaysLabel')}
          description={t('networkSettings.relays.alwaysDesc')}
          checked={mode === 'always'}
          disabled={mode === 'off'}
          onChange={onAlways}
        />
      </div>
    </>
  )
}

interface RelayRowProps {
  relay: RelaySlot
  testing: boolean
  active: boolean
  canTest: boolean
  onTest: () => void
  onReplace: () => void
  onRemove: () => void
}

function RelayRow({ relay, testing, active, canTest, onTest, onReplace, onRemove }: RelayRowProps) {
  const { t } = useTranslation()
  const name = relay.label || relay.publicKey
  const status = statusOf(relay, testing, active)
  // Dimmed with the switch above it, because a relay that is not in use is not in use. The menu
  // stays at full strength: Test, Replace and Remove are the only way to manage the slot, and
  // hiding or disabling them would leave a configured relay with no way to change it.
  const dim = active ? '' : ' opacity-50'
  const statusLabel = t(`networkSettings.relays.${status.key}`)

  return (
    <div className="px-6 py-5 border-t border-outline-variant/40 flex items-center gap-3">
      <div className={`min-w-0 flex-1${dim}`}>
        <p className="font-semibold text-accent truncate">{relay.label || t('networkSettings.relays.unnamed')}</p>
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="font-mono text-xs text-on-surface-variant truncate">
            {truncateRelayKey(relay.publicKey)}
          </span>
          <span className="sr-only">{t('networkSettings.relays.decodedKey', { key: relay.publicKey })}</span>
          <CopyButton value={relay.publicKey} />
        </div>
      </div>
      <Badge
        label={t(`networkSettings.relays.kind.${relay.kind}`)}
        srLabel={t('networkSettings.relays.statusFor', { name, status: t(`networkSettings.relays.kind.${relay.kind}`) })}
        classes={relayKindClasses(relay.kind)}
        className={dim}
      />
      <Badge
        label={statusLabel}
        srLabel={t('networkSettings.relays.statusFor', { name, status: statusLabel })}
        classes={status.classes}
        className={dim}
      />
      <ActionMenu
        label={t('networkSettings.relays.rowMenu', { name })}
        ariaLabel={t('networkSettings.relays.rowMenu', { name })}
        icon="more_vert"
        triggerVariant="subtle"
        items={[
          {
            id: 'test',
            label: t('networkSettings.relays.test'),
            icon: 'refresh',
            // Same rule as handleTest: no dial while nothing is applying the identity.
            disabled: testing || !canTest,
            onAction: onTest,
          },
          {
            id: 'replace',
            label: t('networkSettings.relays.replace'),
            icon: 'edit',
            onAction: onReplace,
          },
          {
            id: 'remove',
            label: t('networkSettings.relays.remove'),
            icon: 'delete',
            variant: 'danger',
            onAction: onRemove,
          },
        ]}
      />
    </div>
  )
}

interface ConfirmRelayLossModalProps {
  intent: 'remove' | 'replace' | null
  name: string
  onClose: () => void
  onConfirm: () => void
}

// Both intents erase the member seed; only the sentence about what happens next differs. No
// onConfirm on the Modal: an alert dialog rests on Cancel, and nothing that destroys an invite
// may fire from a keypress the person did not aim at a button.
function ConfirmRelayLossModal({ intent, name, onClose, onConfirm }: ConfirmRelayLossModalProps) {
  const { t } = useTranslation()
  if (!intent) return null
  const title = t(`networkSettings.relays.${intent}ConfirmTitle`, { name })
  return (
    <ConfirmDestructiveModal
      isOpen
      title={title}
      body={t(`networkSettings.relays.${intent}ConfirmBody`)}
      confirmLabel={t(`networkSettings.relays.${intent}`)}
      onClose={onClose}
      onConfirm={onConfirm}
    >
      <div role="status" className="rounded-xl bg-warning-container px-5 py-3">
        <p className="text-sm text-on-warning-container">{t('networkSettings.relays.restartWarningRemove')}</p>
      </div>
    </ConfirmDestructiveModal>
  )
}

function EmptyRelayRow({ onAdd }: { onAdd: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="px-6 py-5 border-t border-outline-variant/40 flex items-center justify-between gap-6">
      <p className="text-sm text-on-surface-variant leading-relaxed">{t('networkSettings.relays.empty')}</p>
      <Button onClick={onAdd} ariaLabel={t('networkSettings.relays.addAction')} className="shrink-0">
        {t('networkSettings.relays.addAction')}
        <Icon name="add_circle" />
      </Button>
    </div>
  )
}
