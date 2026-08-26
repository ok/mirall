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
import DownloadFolderToastBridge from './components/widgets/DownloadFolderToastBridge.js'
import CommandPalette from './keyboard/CommandPalette.js'
import ShortcutsHint from './keyboard/ShortcutsHint.js'
import { isInSpace, type Command, type CommandContext } from './keyboard/registry.js'
import { spaceDigitAccelerator } from './keyboard/known-commands.js'
import { dispatchSpaceAction, type SpaceAction } from './space-actions.js'
import { docsUrl } from './docs-links.js'
import type { AppNavigation } from './hooks/useAppNavigation.js'
import type { Profile, Space } from './types.js'
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
  'appearance-settings': 'a11y.screens.appearance',
  'notification-settings': 'a11y.screens.notifications',
  'general-settings': 'a11y.screens.general',
  'network-settings': 'a11y.screens.networkSettings',
  'network-status': 'a11y.screens.network',
  'connection-problem': 'a11y.screens.connectionProblem',
  'activity-log': 'a11y.screens.activityLog',
  'activity-log-settings': 'a11y.screens.activityLogSettings',
}

export default function App() {
  const { t } = useTranslation()
  const { profile, needsSetup, loading, saveProfile } = useProfile()
  const { update, dismissed, dismiss } = useUpdates()
  const { spaces, loading: spacesLoading, createSpace, joinSpace, toggleFavorite } = useSpaces()
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
  const openFeedbackModal = useCallback(() => setShowFeedback(true), [])
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

  // The space list rides along because the native menu owns the ⌘1-9 chords: macOS
  // resolves a menu key equivalent before Chromium's own digit accelerators, which
  // otherwise swallow them before the webContents ever sees the key.
  useEffect(() => {
    window.bridge.menuContextChanged({
      inSpace: nav.currentScreen === 'space-view' || nav.currentScreen === 'folder-view',
      spaces: spaces.slice(0, 9).map((s) => ({ id: s.spaceId, name: s.name })),
    }).catch((err) => console.error('menuContextChanged failed:', err))
  }, [nav.currentScreen, spaces])

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
    <ConnectivityToastBridge onShowDetails={() => nav.setCurrentScreen('network-status')} onShowHelp={() => nav.setCurrentScreen('connection-problem')} />
    <DownloadFolderToastBridge onChangeFolder={() => nav.openStorageSettings(nav.currentScreen === 'space-view' ? 'space-view' : 'settings')} />
    <WorkerToastBridge />
    <KeyboardProvider currentScreen={nav.currentScreen} selectedSpaceId={nav.selectedSpaceId}>
      <AppCommands
        nav={nav}
        spaces={spaces}
        canGoBack={canGoBack}
        openWhatsNew={openWhatsNew}
        openFeedback={openFeedbackModal}
        onShowCreate={showCreateModal}
        onShowJoin={showJoinModal}
      />
      <SpaceCommands nav={nav} spaces={spaces} toggleFavorite={toggleFavorite} />
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
  nav: AppNavigation
  spaces: Space[]
  canGoBack: boolean
  openWhatsNew: () => void
  openFeedback: () => void
  onShowCreate: () => void
  onShowJoin: () => void
}

interface SpaceCommandsProps {
  nav: AppNavigation
  spaces: Space[]
  toggleFavorite: (spaceId: string) => Promise<void>
}

const SCREEN_COMMANDS: ReadonlyArray<{ id: string; labelKey: string; screen: string }> = [
  { id: 'activity.openSettings',  labelKey: 'shortcuts.openActivityLogSettings',  screen: 'activity-log-settings' },
  { id: 'network.status',         labelKey: 'shortcuts.openNetworkStatus',        screen: 'network-status' },
  { id: 'settings.appearance',    labelKey: 'shortcuts.openAppearanceSettings',   screen: 'appearance-settings' },
  { id: 'settings.notifications', labelKey: 'shortcuts.openNotificationSettings', screen: 'notification-settings' },
  { id: 'settings.general',       labelKey: 'shortcuts.openGeneralSettings',      screen: 'general-settings' },
  { id: 'settings.network',       labelKey: 'shortcuts.openNetworkSettings',      screen: 'network-settings' },
]

function AppCommands({
  nav,
  spaces,
  canGoBack,
  openWhatsNew,
  openFeedback,
  onShowCreate,
  onShowJoin,
}: AppCommandsProps) {
  const { openPalette, openCheatsheet, registerCommand, runCommand } = useKeyboard()

  const navRef = useRef(nav)
  navRef.current = nav
  const canGoBackRef = useRef(canGoBack)
  canGoBackRef.current = canGoBack

  useRegisterCommand(
    {
      id: 'nav.back',
      labelKey: 'shortcuts.back',
      group: 'navigation',
      when: () => canGoBackRef.current,
      run: () => navRef.current.goBack(),
    },
    [],
  )
  useRegisterCommand(
    {
      id: 'nav.home',
      labelKey: 'shortcuts.home',
      group: 'navigation',
      when: (c) => c.currentScreen !== 'spaces',
      run: () => navRef.current.goHome(),
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
    { id: 'palette.open', labelKey: 'shortcuts.openPalette', group: 'system', hiddenInPalette: true, run: () => openPalette() },
    [],
  )
  useRegisterCommand(
    { id: 'shortcuts.show', labelKey: 'shortcuts.showShortcuts', group: 'system', run: () => openCheatsheet() },
    [],
  )
  useRegisterCommand(
    { id: 'settings.open', labelKey: 'shortcuts.openSettings', group: 'navigation', run: () => navRef.current.openSettings() },
    [],
  )
  useRegisterCommand(
    { id: 'profile.open', labelKey: 'shortcuts.openProfile', group: 'navigation', run: () => navRef.current.openAccount() },
    [],
  )
  useRegisterCommand(
    { id: 'activity.open', labelKey: 'shortcuts.openActivityLog', group: 'navigation', run: () => navRef.current.openActivityLog() },
    [],
  )
  useRegisterCommand(
    { id: 'settings.storage', labelKey: 'shortcuts.openStorageSettings', group: 'navigation', run: () => navRef.current.openStorageSettings('settings') },
    [],
  )
  useRegisterCommand(
    { id: 'space.new', labelKey: 'shortcuts.newSpace', group: 'actions', run: onShowCreate },
    [],
  )
  useRegisterCommand(
    { id: 'space.join', labelKey: 'shortcuts.joinSpace', group: 'actions', run: onShowJoin },
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
  useRegisterCommand(
    { id: 'help.docs', labelKey: 'shortcuts.openDocs', group: 'system', run: () => { window.open(docsUrl({ page: 'hub' }), '_blank', 'noopener') } },
    [],
  )

  useEffect(() => {
    const unregs = SCREEN_COMMANDS.map(({ id, labelKey, screen }) =>
      registerCommand({
        id,
        labelKey,
        group: 'navigation',
        run: () => navRef.current.setCurrentScreen(screen),
      }),
    )
    return () => { unregs.forEach((fn) => fn()) }
  }, [registerCommand])

  // Every space is reachable by name in the palette. The first nine also carry their
  // ⌘1-9 chord, but only as a label: the binding itself lives in the native Go-to-Space
  // menu, because Chromium claims the digit chords before the renderer can see them.
  useEffect(() => {
    const unregs: Array<() => void> = []
    spaces.forEach((space, i) => {
      const cmd: Command = {
        id: `space.open.${space.spaceId}`,
        labelKey: 'shortcuts.openSpace',
        labelParams: { name: space.name },
        group: 'navigation',
        accelerator: spaceDigitAccelerator(i),
        run: () => navRef.current.navigateToSpace(space.spaceId),
      }
      unregs.push(registerCommand(cmd))
    })
    return () => { unregs.forEach((fn) => fn()) }
  }, [spaces, registerCommand])

  return null
}

// Scoped to the space the user is in. Kept apart from AppCommands so each stays readable
// and the space-only lifecycle (pending joins, favourite state) lives in one place.
function SpaceCommands({ nav, spaces, toggleFavorite }: SpaceCommandsProps) {
  const { ctx } = useKeyboard()
  const navRef = useRef(nav)
  navRef.current = nav

  const currentSpace = spaces.find((s) => s.spaceId === ctx.selectedSpaceId)
  const isPendingSpace = currentSpace?.status === 'pending'
  const isFavorite = currentSpace?.favorite === true

  // A pending join is not a membership yet, so the member-only actions stay hidden until it lands.
  const inJoinedSpace = useCallback(
    (c: CommandContext) => isInSpace(c) && !isPendingSpace,
    [isPendingSpace],
  )

  const runSpaceAction = useCallback((c: CommandContext, action: SpaceAction) => {
    if (c.currentScreen === 'space-view') {
      dispatchSpaceAction(action)
      return
    }
    navRef.current.setSelectedShare(null)
    navRef.current.setCurrentScreen('space-view')
    window.setTimeout(() => dispatchSpaceAction(action), 0)
  }, [])

  useRegisterCommand(
    {
      id: 'space.addFiles',
      labelKey: 'shortcuts.addFiles',
      group: 'space',
      when: inJoinedSpace,
      run: (c) => runSpaceAction(c, 'add-files'),
    },
    [inJoinedSpace],
  )
  useRegisterCommand(
    {
      id: 'space.addFolder',
      labelKey: 'shortcuts.addFolder',
      group: 'space',
      when: inJoinedSpace,
      run: (c) => runSpaceAction(c, 'add-folder'),
    },
    [inJoinedSpace],
  )
  useRegisterCommand(
    {
      id: 'space.invite',
      labelKey: 'shortcuts.invite',
      group: 'space',
      when: inJoinedSpace,
      run: (c) => runSpaceAction(c, 'invite'),
    },
    [inJoinedSpace],
  )
  useRegisterCommand(
    {
      id: 'space.edit',
      labelKey: 'shortcuts.editSpace',
      group: 'space',
      when: inJoinedSpace,
      run: (c) => runSpaceAction(c, 'edit'),
    },
    [inJoinedSpace],
  )
  useRegisterCommand(
    {
      id: 'space.leave',
      labelKey: 'shortcuts.leaveSpace',
      group: 'space',
      when: isInSpace,
      run: (c) => runSpaceAction(c, 'leave'),
    },
    [],
  )
  useRegisterCommand(
    {
      id: 'space.favorite',
      labelKey: isFavorite ? 'shortcuts.removeFavorite' : 'shortcuts.addFavorite',
      group: 'space',
      when: inJoinedSpace,
      run: (c) => { if (c.selectedSpaceId) void toggleFavorite(c.selectedSpaceId) },
    },
    [isFavorite, inJoinedSpace],
  )
  useRegisterCommand(
    {
      id: 'space.manageStorage',
      labelKey: 'shortcuts.manageStorage',
      group: 'space',
      when: inJoinedSpace,
      run: () => navRef.current.openStorageSettings('space-view'),
    },
    [inJoinedSpace],
  )

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
