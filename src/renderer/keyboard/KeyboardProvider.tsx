// Keyboard context: dynamic command registry, global hotkey dispatch, and command-palette / cheatsheet open state.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DependencyList,
  type ReactNode,
} from 'react'
import type { Command, CommandContext } from './registry.js'
import { GLOBAL_HOTKEYS } from './registry.js'
import { createCommandContext, matchAccelerator, shouldIgnore } from './accelerator.js'
import { acceleratorFor } from './known-commands.js'
import { CLOSE_MODALS_EVENT } from '../components/primitives/Modal.js'

interface KeyboardApi {
  registerCommand: (cmd: Command) => () => void
  runCommand: (id: string) => void
  openPalette: () => void
  closePalette: () => void
  paletteOpen: boolean
  cheatsheetOpen: boolean
  openCheatsheet: () => void
  closeCheatsheet: () => void
  commands: Command[]
  ctx: CommandContext
}

const KeyboardContext = createContext<KeyboardApi | null>(null)

interface ProviderProps {
  currentScreen: string
  selectedSpaceId: string | null
  children: ReactNode
}

export function KeyboardProvider({ currentScreen, selectedSpaceId, children }: ProviderProps) {
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [cheatsheetOpen, setCheatsheetOpen] = useState(false)
  const commandsRef = useRef<Map<string, Command>>(new Map())
  const [version, setVersion] = useState(0)

  const ctxRef = useRef<CommandContext>({
    currentScreen,
    selectedSpaceId,
    isInputFocused: false,
  })

  const ctx = useMemo<CommandContext>(
    () => createCommandContext({ currentScreen, selectedSpaceId }),
    [currentScreen, selectedSpaceId],
  )
  ctxRef.current = ctx

  const commands = useMemo(() => {
    const all = Array.from(commandsRef.current.values())
    return all.filter((c) => !c.when || c.when(ctx))
  }, [ctx, version])

  const registerCommand = useCallback((cmd: Command) => {
    commandsRef.current.set(cmd.id, cmd)
    setVersion((n) => n + 1)
    return () => {
      const current = commandsRef.current.get(cmd.id)
      if (current === cmd) commandsRef.current.delete(cmd.id)
      setVersion((n) => n + 1)
    }
  }, [])

  const runCommand = useCallback((id: string) => {
    const cmd = commandsRef.current.get(id)
    if (!cmd) return
    const liveCtx = createCommandContext({
      currentScreen: ctxRef.current.currentScreen,
      selectedSpaceId: ctxRef.current.selectedSpaceId,
    })
    if (cmd.when && !cmd.when(liveCtx)) return
    Promise.resolve(cmd.run(liveCtx)).catch((err) =>
      console.error('command failed:', id, err),
    )
  }, [])

  const openPalette = useCallback(() => setPaletteOpen(true), [])
  const closePalette = useCallback(() => setPaletteOpen(false), [])
  const openCheatsheet = useCallback(() => setCheatsheetOpen(true), [])
  const closeCheatsheet = useCallback(() => setCheatsheetOpen(false), [])

  const dispatch = useCallback((id: string) => {
    window.dispatchEvent(new Event(CLOSE_MODALS_EVENT))
    if (id === 'palette.open') { setPaletteOpen(true); return }
    if (id === 'shortcuts.show') { setCheatsheetOpen(true); return }
    runCommand(id)
  }, [runCommand])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        if (paletteOpen) {
          setPaletteOpen(false)
          e.preventDefault()
          return
        }
        if (cheatsheetOpen) {
          setCheatsheetOpen(false)
          e.preventDefault()
          return
        }
        return
      }
      if (shouldIgnore(e, GLOBAL_HOTKEYS)) return
      const liveCtx = createCommandContext({
        currentScreen: ctxRef.current.currentScreen,
        selectedSpaceId: ctxRef.current.selectedSpaceId,
      })
      for (const cmd of commandsRef.current.values()) {
        if (!cmd.accelerator) continue
        if (cmd.when && !cmd.when(liveCtx)) continue
        if (matchAccelerator(e, cmd.accelerator)) {
          e.preventDefault()
          dispatch(cmd.id)
          return
        }
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [paletteOpen, cheatsheetOpen, dispatch])

  useEffect(() => {
    return window.bridge.onKeyboardCommand((id) => dispatch(id))
  }, [dispatch])

  const api: KeyboardApi = {
    registerCommand,
    runCommand,
    paletteOpen,
    openPalette,
    closePalette,
    cheatsheetOpen,
    openCheatsheet,
    closeCheatsheet,
    commands,
    ctx,
  }

  return <KeyboardContext.Provider value={api}>{children}</KeyboardContext.Provider>
}

export function useKeyboard(): KeyboardApi {
  const v = useContext(KeyboardContext)
  if (!v) throw new Error('useKeyboard must be used inside KeyboardProvider')
  return v
}

export function useRegisterCommand(cmd: Command, deps: DependencyList): void {
  const { registerCommand } = useKeyboard()
  const cmdRef = useRef(cmd)
  cmdRef.current = cmd
  useEffect(() => {
    const stable: Command = {
      id: cmd.id,
      labelKey: cmd.labelKey,
      labelParams: cmd.labelParams,
      group: cmd.group,
      accelerator: cmd.accelerator ?? acceleratorFor(cmd.id),
      when: cmd.when ? (ctx) => (cmdRef.current.when ? cmdRef.current.when(ctx) : true) : undefined,
      run: (ctx) => cmdRef.current.run(ctx),
    }
    return registerCommand(stable)
  }, deps)
}
