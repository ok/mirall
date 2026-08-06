// Root app shell: screen state machine (spaces → space/folder views, settings stack), global providers, modals, and menu wiring.
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useProfile } from './hooks/useProfile.js'
import { useUpdates } from './hooks/useUpdates.js'
import { useSpaces } from './hooks/useSpaces.js'
import { useAppNavigation } from './hooks/useAppNavigation.js'
import { useAppShellEffects } from './hooks/useAppShellEffects.js'
import Onboarding from './screens/Onboarding.js'
import ScreenRouter from './components/layout/ScreenRouter.js'
import TopNav from './components/layout/TopNav.js'
import FeedbackModal from './components/modals/FeedbackModal.js'
import WhatsNewModal from './components/modals/WhatsNewModal.js'
import CreateSpaceModal from './components/modals/CreateSpaceModal.js'
import JoinSpaceModal from './components/modals/JoinSpaceModal.js'
import { KeyboardProvider, useKeyboard, useRegisterCommand } from './keyboard/KeyboardProvider.js'
import { ToastProvider, useToast } from './components/toast/ToastProvider.js'
import { ConnectionStatusProvider } from './hooks/useConnectionStatus.js'
import ConnectivityToastBridge from './components/widgets/ConnectivityToastBridge.js'
import WorkerToastBridge from './components/widgets/WorkerToastBridge.js'
import CommandPalette from './keyboard/CommandPalette.js'
import ShortcutsHint from './keyboard/ShortcutsHint.js'
import type { Command } from './keyboard/registry.js'
import { HOME_ACCELERATOR } from './keyboard/known-commands.js'
import type { Space } from './types.js'
import type { DeepLinkPayload } from './global.js'
import { decodeInvite } from './invite-envelope.js'
import { request, subscribe } from './ipc.js'
import { useNotificationClickRouter } from './notifications/click-router.js'
import { checkChangelogOnBoot, loadAllEntries } from './changelog.js'
import * as whatsNew from './whats-new.js'
import { useSkipLinkFocusGuard } from './hooks/useSkipLinkFocusGuard.js'

interface JoinPrefill {
  code: string
  name?: string
}

const SCREEN_TITLE_KEYS: Record<string, string> = {
  'spaces': 'a11y.screens.spaces',
  'space-view': 'a11y.screens.spaceView',
  'folder-view': 'a11y.screens.folderView',
  'settings': 'a11y.screens.settings',
  'account': 'a11y.screens.account',
  'storage-settings': 'a11y.screens.storage',
  'about': 'a11y.screens.about',
  'appearance-settings': 'a11y.screens.appearance',
  'notification-settings': 'a11y.screens.notifications',
  'general-settings': 'a11y.screens.general',
  'network-status': 'a11y.screens.network',
  'activity-log': 'a11y.screens.activityLog',
  'activity-log-settings': 'a11y.screens.activityLogSettings',
}

export default function App() {
  const { t } = useTranslation()
  const { profile, needsSetup, loading, saveProfile } = useProfile()
  const { update, dismissed, dismiss } = useUpdates()
  const { spaces, loading: spacesLoading, createSpace, joinSpace } = useSpaces()
  const nav = useAppNavigation()

  const [showFeedback, setShowFeedback] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [showJoin, setShowJoin] = useState(false)
  const [joinPrefill, setJoinPrefill] = useState<JoinPrefill | null>(null)
  const [linkQueue, setLinkQueue] = useState<DeepLinkPayload[]>([])
  const mainRef = useRef<HTMLElement>(null)
  const mountedRef = useRef(false)
  const [routeAnnounce, setRouteAnnounce] = useState('')

  useAppShellEffects(spaces)

  useEffect(() => {
    return window.bridge.deepLink.subscribe((link) => {
      setLinkQueue((q) => [...q, link])
    })
  }, [])

  const onSkipLinkFocus = useSkipLinkFocusGuard()

  const openWhatsNew = useCallback(() => {
    loadAllEntries()
      .then((all) => { if (all.length) whatsNew.open(all, 'all') })
      .catch((err) => console.error('loadAllEntries failed:', err))
  }, [])

  const showCreateModal = useCallback(() => setShowCreate(true), [])
  const showJoinModal = useCallback(() => setShowJoin(true), [])

  // Suppress back navigation at the root and while a top-level modal is open
  // (so the gesture doesn't navigate the screen out from under a dialog).
  const canGoBack = nav.currentScreen !== 'spaces' && !showCreate && !showJoin && !showFeedback

  // If the space we're viewing vanishes (e.g. a pending join was denied and the
  // worker dropped it), don't leave the user staring at a dead view — go home.
  useEffect(() => {
    if (spacesLoading) return
    if (nav.currentScreen === 'space-view' && nav.selectedSpaceId && !spaces.some((s) => s.spaceId === nav.selectedSpaceId)) {
      nav.goHome()
    }
  }, [spacesLoading, nav.currentScreen, nav.selectedSpaceId, spaces, nav.goHome])

  const clickDeps = useMemo(() => ({ navigateToSpace: nav.navigateToSpace }), [nav.navigateToSpace])
  useNotificationClickRouter(clickDeps)

  useEffect(() => {
    return window.bridge.onHiddenToTray(() => {
      nav.resetToRoot()
      setShowFeedback(false)
    })
  }, [nav.resetToRoot])

  useEffect(() => {
    if (loading) return
    checkChangelogOnBoot(!needsSetup).then((entries) => {
      if (entries) whatsNew.open(entries)
    })
  }, [loading, needsSetup])

  useEffect(() => {
    if (!mountedRef.current) { mountedRef.current = true; return }
    mainRef.current?.focus()
    const key = SCREEN_TITLE_KEYS[nav.currentScreen]
    setRouteAnnounce(key ? t(key) : '')
  }, [nav.currentScreen, t])

  useEffect(() => {
    window.bridge.menuContextChanged({ inSpace: nav.currentScreen === 'space-view' })
      .catch((err) => console.error('menuContextChanged failed:', err))
  }, [nav.currentScreen])

  if (loading) return (
    <main className="min-h-screen bg-surface flex items-center justify-center">
      <h1 className="sr-only">{t('boot.loading')}</h1>
      <p role="status" className="text-on-surface text-lg">{t('boot.loading')}</p>
    </main>
  )
  if (needsSetup) return <Onboarding onComplete={saveProfile} />

  return (
    <ToastProvider>
    <ConnectionStatusProvider>
    <ConnectivityToastBridge onShowDetails={() => nav.setCurrentScreen('network-status')} />
    <WorkerToastBridge />
    <KeyboardProvider currentScreen={nav.currentScreen} selectedSpaceId={nav.selectedSpaceId}>
      <AppCommands
        spaces={spaces}
        openSettings={nav.openSettings}
        openAbout={nav.openAbout}
        openWhatsNew={openWhatsNew}
        openFeedback={() => setShowFeedback(true)}
        navigateToSpace={nav.navigateToSpace}
        onShowCreate={showCreateModal}
        onShowJoin={showJoinModal}
        goBack={nav.goBack}
        canGoBack={canGoBack}
        goHome={nav.goHome}
      />
      <DeepLinkRouter
        spaces={spaces}
        linkQueue={linkQueue}
        setLinkQueue={setLinkQueue}
        navigateToSpace={nav.navigateToSpace}
        setShowJoin={setShowJoin}
        setJoinPrefill={setJoinPrefill}
      />
      <JoinRequestNotifier spaces={spaces} navigateToSpace={nav.navigateToSpace} />
      <div className="min-h-screen bg-surface">
        <a
          href="#main-content"
          onFocus={onSkipLinkFocus}
          className="sr-only focus:not-sr-only focus:fixed focus:z-[100] focus:top-4 focus:left-4 focus:px-4 focus:py-2 focus:rounded-lg focus:bg-primary focus:text-on-primary focus:shadow-lg"
        >
          {t('a11y.skipToContent')}
        </a>
        <div aria-live="polite" className="sr-only">{routeAnnounce}</div>
        <TopNav
          profile={profile}
          onLogoClick={nav.goHome}
          onSettingsClick={nav.openSettings}
          onAccountClick={nav.openAccount}
          onFeedbackClick={() => setShowFeedback(true)}
          update={dismissed ? null : update}
          onDismissUpdate={dismiss}
        />
        <FeedbackModal isOpen={showFeedback} onClose={() => setShowFeedback(false)} />
        <WhatsNewModal />
        <CreateSpaceModal
          isOpen={showCreate}
          onClose={() => setShowCreate(false)}
          onCreate={createSpace}
          onCreated={(space) => nav.navigateToSpace(space.spaceId)}
        />
        <JoinSpaceModal
          isOpen={showJoin}
          initialCode={joinPrefill?.code}
          initialName={joinPrefill?.name}
          onClose={() => {
            setShowJoin(false)
            setJoinPrefill(null)
          }}
          onJoin={joinSpace}
          onJoined={(space) => nav.navigateToSpace(space.spaceId)}
        />
        <CommandPalette />
        <ShortcutsHint />
      <main id="main-content" ref={mainRef} tabIndex={-1} className="pt-[calc(5rem+var(--banner-h,0px))] focus:outline-none">
        <ScreenRouter
          nav={nav}
          profile={profile}
          onSaveProfile={saveProfile}
          onOpenFeedback={() => setShowFeedback(true)}
          onShowCreate={showCreateModal}
          onShowJoin={showJoinModal}
        />
      </main>
      </div>
    </KeyboardProvider>
    </ConnectionStatusProvider>
    </ToastProvider>
  )
}

interface AppCommandsProps {
  spaces: Space[]
  openSettings: () => void
  openAbout: () => void
  openWhatsNew: () => void
  openFeedback: () => void
  navigateToSpace: (spaceId: string) => void
  onShowCreate: () => void
  onShowJoin: () => void
  goBack: () => void
  canGoBack: boolean
  goHome: () => void
}

function AppCommands({
  spaces,
  openSettings,
  openAbout,
  openWhatsNew,
  openFeedback,
  navigateToSpace,
  onShowCreate,
  onShowJoin,
  goBack,
  canGoBack,
  goHome,
}: AppCommandsProps) {
  const { openPalette, openCheatsheet, registerCommand, runCommand } = useKeyboard()

  const canGoBackRef = useRef(canGoBack)
  canGoBackRef.current = canGoBack
  const goBackRef = useRef(goBack)
  goBackRef.current = goBack

  useRegisterCommand(
    {
      id: 'nav.back',
      labelKey: 'shortcuts.back',
      group: 'navigation',
      accelerator: 'mod+arrowleft',
      when: () => canGoBackRef.current,
      run: () => goBackRef.current(),
    },
    [],
  )
  useRegisterCommand(
    {
      id: 'nav.home',
      labelKey: 'shortcuts.home',
      group: 'navigation',
      accelerator: HOME_ACCELERATOR,
      when: (ctx) => ctx.currentScreen !== 'spaces',
      run: goHome,
    },
    [],
  )

  // Mouse "back" side button (button 3) — the OS-consistent back gesture.
  // Windows browser-backward app-command and macOS trackpad swipe arrive
  // separately via the main process as a 'nav.back' keyboard:command.
  useEffect(() => {
    const onMouseUp = (e: MouseEvent): void => {
      if (e.button !== 3) return
      e.preventDefault()
      runCommand('nav.back')
    }
    window.addEventListener('mouseup', onMouseUp)
    return () => window.removeEventListener('mouseup', onMouseUp)
  }, [runCommand])

  useRegisterCommand(
    { id: 'palette.open', labelKey: 'shortcuts.openPalette', group: 'system', accelerator: 'mod+k', run: () => openPalette() },
    [],
  )
  useRegisterCommand(
    { id: 'shortcuts.show', labelKey: 'shortcuts.showShortcuts', group: 'system', accelerator: 'mod+/', run: () => openCheatsheet() },
    [],
  )
  useRegisterCommand(
    { id: 'settings.open', labelKey: 'shortcuts.openSettings', group: 'navigation', accelerator: 'mod+,', run: openSettings },
    [],
  )
  useRegisterCommand(
    { id: 'space.new', labelKey: 'shortcuts.newSpace', group: 'actions', accelerator: 'mod+n', run: onShowCreate },
    [],
  )
  useRegisterCommand(
    { id: 'space.join', labelKey: 'shortcuts.joinSpace', group: 'actions', accelerator: 'mod+j', run: onShowJoin },
    [],
  )
  useRegisterCommand(
    { id: 'about.open', labelKey: 'shortcuts.openAbout', group: 'navigation', run: openAbout },
    [],
  )
  useRegisterCommand(
    { id: 'help.whatsNew', labelKey: 'shortcuts.whatsNew', group: 'system', run: openWhatsNew },
    [],
  )
  useRegisterCommand(
    { id: 'help.feedback', labelKey: 'shortcuts.sendFeedback', group: 'system', run: openFeedback },
    [],
  )

  useEffect(() => {
    const unregs: Array<() => void> = []
    const max = Math.min(10, spaces.length)
    for (let i = 0; i < max; i++) {
      const space = spaces[i]
      if (!space) continue
      const cmd: Command = {
        id: `space.open.${space.spaceId}`,
        labelKey: 'shortcuts.openSpace',
        labelParams: { name: space.name },
        group: 'navigation',
        run: () => navigateToSpace(space.spaceId),
      }
      unregs.push(registerCommand(cmd))
    }
    return () => { unregs.forEach((fn) => fn()) }
  }, [spaces, navigateToSpace, registerCommand])

  return null
}

interface DeepLinkRouterProps {
  spaces: Space[]
  linkQueue: DeepLinkPayload[]
  setLinkQueue: (next: DeepLinkPayload[]) => void
  navigateToSpace: (spaceId: string) => void
  setShowJoin: (open: boolean) => void
  setJoinPrefill: (prefill: JoinPrefill | null) => void
}

function DeepLinkRouter({
  spaces,
  linkQueue,
  setLinkQueue,
  navigateToSpace,
  setShowJoin,
  setJoinPrefill,
}: DeepLinkRouterProps) {
  const { t } = useTranslation()
  const toast = useToast()
  const spacesRef = useRef(spaces)
  spacesRef.current = spaces

  useEffect(() => {
    if (linkQueue.length === 0) return
    for (const link of linkQueue) {
      if (link.kind !== 'join') continue
      const decoded = decodeInvite(link.code)
      if (!decoded) {
        toast.error(t('joinSpace.invalidLink'))
        continue
      }
      if (decoded.v === 1 && decoded.expiresAt && decoded.expiresAt + 60_000 < Date.now()) {
        toast.error(t('joinSpace.expiredLink'))
        continue
      }
      const existing = spacesRef.current.find((s) => s.topic === decoded.topic)
      if (existing) {
        navigateToSpace(existing.spaceId)
        toast.info(t('joinSpace.alreadyMember', { name: existing.name }))
        continue
      }
      setJoinPrefill({ code: link.code, name: link.name })
      setShowJoin(true)
    }
    setLinkQueue([])
  }, [linkQueue, navigateToSpace, setShowJoin, setJoinPrefill, setLinkQueue, t, toast])

  return null
}

// Surfaces join requests app-wide (any screen), so existing members notice even when
// they're not looking at the space. Review navigates to the space, where the banner
// (and modal for several requests) holds the actual Approve/Deny controls.
function JoinRequestNotifier({ spaces, navigateToSpace }: { spaces: Space[]; navigateToSpace: (spaceId: string) => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const spacesRef = useRef(spaces)
  spacesRef.current = spaces
  // Join-request toasts we've shown, per space, so we can dismiss them once the request is
  // resolved — including when ANOTHER member approves/denies it. Approval only needs doing
  // once; a sticky "X wants to join" on every other member is stale the moment one acts.
  const shownRef = useRef<Map<string, Set<string>>>(new Map())

  useEffect(() => {
    const nameOf = (spaceId: string) => spacesRef.current.find((s) => s.spaceId === spaceId)?.name ?? ''
    const toastId = (spaceId: string, publicKey: string) => `join-req:${spaceId}:${publicKey}`
    const remember = (spaceId: string, publicKey: string) => {
      let set = shownRef.current.get(spaceId)
      if (!set) shownRef.current.set(spaceId, set = new Set())
      set.add(publicKey)
    }
    const dismissFor = (spaceId: string, publicKey: string) => {
      toast.dismiss(toastId(spaceId, publicKey))
      shownRef.current.get(spaceId)?.delete(publicKey)
    }

    const unsubReq = subscribe<{ spaceId: string; publicKey: string; displayName: string }>('event:member-join-request', (msg) => {
      remember(msg.spaceId, msg.publicKey)
      // Sticky (duration 0): a pending approval must not vanish on a timer. The deterministic
      // id lets us dismiss this exact toast when the request is resolved (here or elsewhere).
      toast.info(t('member.joinRequestToast', { name: msg.displayName, space: nameOf(msg.spaceId) }), {
        id: toastId(msg.spaceId, msg.publicKey),
        duration: 0,
        action: { label: t('member.review'), onClick: () => navigateToSpace(msg.spaceId) },
      })
    })
    // The request set changed (approved / denied / cancelled — possibly by another member).
    // Re-read the pending set and dismiss any toast no longer backed by a live request.
    const unsubResolved = subscribe<{ spaceId: string }>('event:join-requests-updated', (msg) => {
      const shown = shownRef.current.get(msg.spaceId)
      if (!shown || shown.size === 0) return
      request('space:pending-requests', { spaceId: msg.spaceId }).then((result) => {
        const pending = new Set((result as Array<{ publicKey: string }>).map((r) => r.publicKey))
        for (const publicKey of [...shown]) if (!pending.has(publicKey)) dismissFor(msg.spaceId, publicKey)
      }).catch(() => {})
    })
    // A requester now admitted as a member is resolved — dismiss immediately (covers the
    // approver and every co-member the moment the new member is admitted on their peer).
    const unsubJoined = subscribe<{ spaceId: string; member?: { publicKey?: string } }>('event:member-joined', (msg) => {
      if (msg.member?.publicKey) dismissFor(msg.spaceId, msg.member.publicKey)
    })
    const unsubGranted = subscribe<{ spaceId: string }>('event:membership-granted', (msg) => {
      toast.success(t('member.membershipGranted', { space: nameOf(msg.spaceId) }), {
        action: { label: t('member.open'), onClick: () => navigateToSpace(msg.spaceId) },
      })
    })
    const unsubDenied = subscribe<{ spaceId: string }>('event:membership-denied', (msg) => {
      // Sticky: a declined joiner should not miss the outcome to a timer.
      toast.error(t('member.membershipDenied', { space: nameOf(msg.spaceId) }), { duration: 0 })
    })
    return () => { unsubReq(); unsubResolved(); unsubJoined(); unsubGranted(); unsubDenied() }
  }, [navigateToSpace, t, toast])

  return null
}
