// Accessible dropdown menu button (react-aria); the popup portals to the body and
// tracks the trigger's position on scroll/resize, with keyboard and dismiss handling.
import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useMenuTrigger, useMenu, useMenuItem, useFocusRing, useButton, useOverlay, DismissButton, FocusScope } from 'react-aria'
import { useMenuTriggerState } from '@react-stately/menu'
import { useTreeState, type TreeState } from '@react-stately/tree'
import { Item } from '@react-stately/collections'
import type { Node, Key, CollectionElement, FocusStrategy } from '@react-types/shared'
import Icon from './Icon.js'
import type { IconName } from '../../types/ui.js'

export interface ActionMenuItemConfig {
  id: string
  label: string
  icon?: IconName
  iconFilled?: boolean
  onAction: () => void
  variant?: 'default' | 'danger'
  disabled?: boolean
  hint?: string
  /** A second line under the label. */
  description?: string
  /** Set (true or false), the item is one of the menu's choices: a radio item, checked or not. An
   *  item without it is an action, whatever choices sit beside it. */
  checked?: boolean
  /** A rule above this item. */
  separatorBefore?: boolean
}

interface ActionMenuProps {
  label: string
  icon?: IconName
  items: ActionMenuItemConfig[]
  // 'primary' is the key action on a screen; 'subtle' is the icon-only three-dot trigger;
  // 'neutral' wears the secondary-button tokens, for places where several menus sit together and
  // none of them is the screen's main action (a filter bar); 'split-end' is the chevron half of a
  // split button whose other half is a primary Button; neither half shrinks on press.
  triggerVariant?: 'primary' | 'subtle' | 'neutral' | 'split-end'
  /** 'warning' recolours a neutral trigger for a choice that cannot be used right now. */
  triggerTone?: 'default' | 'warning'
  ariaLabel?: string
  /** The trigger's tooltip. */
  title?: string
  /** A non-interactive heading at the top of the popup. */
  heading?: string
  /** A labelled trigger's widest extent; its label truncates inside it. */
  maxWidthClass?: string
  /** The popup's width bounds; a description longer than the upper one truncates. */
  popupWidthClass?: string
  /** Called each time the menu opens. */
  onOpen?: () => void
}

function MenuItemRow({ node, state, config, showSeparator }: {
  node: Node<object>
  state: TreeState<object>
  config: ActionMenuItemConfig
  showSeparator: boolean
}) {
  const ref = useRef<HTMLLIElement>(null)
  const { menuItemProps, labelProps, descriptionProps, isFocused } = useMenuItem(
    { key: node.key, isDisabled: config.disabled === true },
    state,
    ref
  )
  const { isFocusVisible, focusProps } = useFocusRing()

  const isDanger = config.variant === 'danger'
  const isDisabled = config.disabled === true
  const isChoice = config.checked !== undefined

  return (
    <>
      {showSeparator && (
        <li className="mx-3 my-1 border-t border-outline/10" role="separator" />
      )}
      <li
        {...menuItemProps}
        {...focusProps}
        ref={ref}
        role={isChoice ? 'menuitemradio' : 'menuitem'}
        aria-checked={isChoice ? config.checked : undefined}
        title={config.hint}
        aria-disabled={isDisabled || undefined}
        className={`
          w-full px-4 py-3 text-left text-sm font-medium
          flex items-center gap-3 outline-none
          ${isDisabled
      ? 'text-outline cursor-not-allowed opacity-60'
      : `cursor-pointer active:scale-[0.98] transition-all ${
        isDanger
          ? 'text-error hover:bg-error-container hover:text-on-error-container'
          : 'text-accent hover:bg-surface-container-low'
      } ${isFocused || isFocusVisible ? 'bg-surface-container-low' : ''}`
    }
        `}
      >
        {config.icon
          ? <Icon name={config.icon} filled={config.iconFilled} size={20} className="shrink-0" />
          : <span className="w-5 h-5 shrink-0" aria-hidden="true" />}
        <span className="flex-grow min-w-0 whitespace-nowrap">
          <span {...labelProps} className={config.description ? 'block truncate' : undefined}>{config.label}</span>
          {config.description && (
            <span {...descriptionProps} className="block text-xs font-normal text-on-surface-variant truncate">{config.description}</span>
          )}
        </span>
        {isDisabled && config.hint && (
          <Icon name="info" size={14} className="text-outline opacity-70" />
        )}
      </li>
    </>
  )
}

interface MenuPosition { top: number; right: number; maxWidth: number }

// Measured synchronously for the initial state, not only from the layout effect, so the popup
// renders its <ul> on the very first render: react-aria's autoFocus effect is one-shot, and a first
// render that bails to `null` spends it while menuRef is still empty.
function measurePosition(trigger: HTMLButtonElement | null, menuHeight = 0): MenuPosition | null {
  if (!trigger) return null
  const rect = trigger.getBoundingClientRect()
  const gap = 8
  const edgeMargin = 16
  const right = Math.max(edgeMargin, window.innerWidth - rect.right)
  const maxWidth = window.innerWidth - right - edgeMargin
  // Flip above the trigger when the popup would run past the bottom of the window (a trigger low in
  // a scrolling pane). menuHeight is 0 on the first measure, before the <ul> exists; the layout
  // effect re-measures with the real height before paint.
  const below = rect.bottom + gap
  const overflows = menuHeight > 0 && below + menuHeight + edgeMargin > window.innerHeight
  const top = overflows ? Math.max(edgeMargin, rect.top - gap - menuHeight) : below
  return { top, right, maxWidth }
}

function MenuPopup({ items, heading, widthClass, onAction, onClose, menuProps: externalMenuProps, triggerRef, autoFocus }: {
  items: ActionMenuItemConfig[]
  heading?: string
  widthClass: string
  onAction: (key: Key) => void
  onClose: () => void
  menuProps: ReturnType<typeof useMenuTrigger>['menuProps']
  triggerRef: React.RefObject<HTMLButtonElement | null>
  autoFocus: FocusStrategy | boolean
}) {
  const overlayRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLUListElement>(null)
  const [position, setPosition] = useState<MenuPosition | null>(() => measurePosition(triggerRef.current))

  useLayoutEffect(() => {
    const trigger = triggerRef.current
    if (!trigger) return
    const computePosition = () => setPosition(measurePosition(trigger, menuRef.current?.offsetHeight ?? 0))
    computePosition()
    window.addEventListener('resize', computePosition)
    window.addEventListener('scroll', computePosition, true)
    return () => {
      window.removeEventListener('resize', computePosition)
      window.removeEventListener('scroll', computePosition, true)
    }
  }, [triggerRef])

  const { overlayProps } = useOverlay(
    { isOpen: true, onClose, isDismissable: true, shouldCloseOnBlur: true },
    overlayRef
  )

  const children = items.map(item => (
    <Item key={item.id}>{item.label}</Item>
  )) as CollectionElement<object>[]

  const disabledKeys = items.filter((i) => i.disabled).map((i) => i.id)
  // Picking any item is an action, a choice included, so the menu keeps no selection of its own:
  // each item says per item whether it is a choice and whether it is the chosen one (MenuItemRow).
  const treeState = useTreeState({ children, selectionMode: 'none', disabledKeys })

  // `autoFocus` is what puts focus *inside* the portalled overlay. react-aria binds the
  // Escape shortcut to the overlay's own onKeyDown, so it only fires for a keydown raised
  // within that subtree — with focus left on the trigger the menu could never be dismissed
  // by keyboard, and arrow-key navigation never started either.
  const { menuProps } = useMenu(
    { ...externalMenuProps, onAction, autoFocus },
    treeState,
    menuRef
  )

  if (typeof document === 'undefined') return null
  if (!position) return null

  // `contain` keeps Tab inside the open menu instead of walking the page behind it;
  // `restoreFocus` hands focus back to the trigger when the popup unmounts.
  return createPortal(
    <FocusScope contain restoreFocus>
      <div
        {...overlayProps}
        ref={overlayRef}
        style={{ position: 'fixed', top: position.top, right: position.right, maxWidth: position.maxWidth, zIndex: 60 }}
      >
        <DismissButton onDismiss={onClose} />
        <ul
          {...menuProps}
          ref={menuRef}
          className={`${widthClass} bg-surface-container-lowest rounded-xl shadow-[0_8px_18px_-4px_rgba(0,0,0,0.4)] dark:shadow-[0_8px_18px_-4px_rgba(0,0,0,0.6)] overflow-hidden outline-none py-1`}
        >
          {heading && (
            <li role="presentation" className="px-4 pt-2 pb-1 text-xs font-bold uppercase tracking-wide text-secondary">{heading}</li>
          )}
          {[...treeState.collection].map((node, index) => {
            const config = items.find(i => i.id === node.key)
            if (!config) return null

            const showSeparator = index > 0 && (config.separatorBefore === true || config.variant === 'danger')

            return (
              <MenuItemRow
                key={String(node.key)}
                node={node}
                state={treeState}
                config={config}
                showSeparator={showSeparator}
              />
            )
          })}
        </ul>
        <DismissButton onDismiss={onClose} />
      </div>
    </FocusScope>,
    document.body,
  )
}

function triggerClassFor(variant: ActionMenuProps['triggerVariant'], tone: ActionMenuProps['triggerTone'], isPressed: boolean, maxWidthClass?: string): string {
  const pressed = isPressed ? 'scale-95' : ''
  if (variant === 'subtle') return `w-10 h-10 rounded-full flex items-center justify-center control-hover active:scale-95 transition-all focus-ring ${pressed}`
  if (variant === 'split-end') return 'h-full flex items-center justify-center rounded-xl rounded-l-none px-2.5 split-divider bg-primary text-on-primary shadow-lg shadow-primary/10 hover:bg-primary-hover transition-all focus-ring'
  const labelledBase = `flex items-center gap-2 rounded-xl px-5 py-2.5 font-headline font-bold text-sm transition-all focus-ring${maxWidthClass ? ' min-w-0 ' + maxWidthClass : ''}`
  if (variant === 'neutral') {
    const fill = tone === 'warning' ? 'bg-warning-container text-on-warning-container' : 'bg-surface-control text-on-surface-variant hover:bg-surface-control-hover'
    return `${labelledBase} ${fill} ${pressed}`
  }
  return `${labelledBase} bg-primary text-on-primary shadow-lg shadow-primary/10 hover:bg-primary-hover ${pressed}`
}

export default function ActionMenu({ label, icon, items, triggerVariant, triggerTone, ariaLabel, title, heading, maxWidthClass, popupWidthClass = 'min-w-[10rem]', onOpen }: ActionMenuProps) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const state = useMenuTriggerState({ onOpenChange: (isOpen) => { if (isOpen) onOpen?.() } })
  const { menuTriggerProps, menuProps } = useMenuTrigger(
    { type: 'menu' },
    state,
    triggerRef
  )
  const { buttonProps, isPressed } = useButton(menuTriggerProps, triggerRef)

  function handleAction(key: Key) {
    const item = items.find(i => i.id === key)
    if (!item || item.disabled) return
    item.onAction()
    state.close()
  }

  const chevron = (
    <Icon
      name="keyboard_arrow_down"
      size={20}
      className={`shrink-0 transition-transform ${state.isOpen ? 'rotate-180' : ''}`}
    />
  )

  return (
    <div className={maxWidthClass ? 'relative min-w-0' : 'relative'}>
      <button
        {...buttonProps}
        ref={triggerRef}
        aria-label={ariaLabel ?? label}
        title={title}
        className={triggerClassFor(triggerVariant, triggerTone, isPressed, maxWidthClass)}
      >
        {triggerVariant === 'subtle' ? (
          <Icon name={icon ?? 'more_vert'} size={22} className="text-secondary" />
        ) : triggerVariant === 'split-end' ? (
          chevron
        ) : (
          <>
            {icon && <Icon name={icon} size={20} className={maxWidthClass ? 'shrink-0' : undefined} />}
            {maxWidthClass ? <span className="truncate">{label}</span> : label}
            {chevron}
          </>
        )}
      </button>

      {state.isOpen && (
        <MenuPopup
          items={items}
          heading={heading}
          widthClass={popupWidthClass}
          onAction={handleAction}
          onClose={() => state.close()}
          menuProps={menuProps}
          triggerRef={triggerRef}
          // Set only when opened by keyboard (ArrowDown -> 'first'); a mouse open leaves it
          // null, so fall back to `true` — focus has to enter the popup however it opened.
          autoFocus={state.focusStrategy ?? true}
        />
      )}
    </div>
  )
}
