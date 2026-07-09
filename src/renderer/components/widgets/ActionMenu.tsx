// Accessible dropdown menu button (react-aria); the popup portals to the body and
// tracks the trigger's position on scroll/resize, with keyboard and dismiss handling.
import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useMenuTrigger, useMenu, useMenuItem, useFocusRing, useButton, useOverlay, DismissButton } from 'react-aria'
import { useMenuTriggerState } from '@react-stately/menu'
import { useTreeState, type TreeState } from '@react-stately/tree'
import { Item } from '@react-stately/collections'
import type { Node, Key, CollectionElement } from '@react-types/shared'
import Icon, { type IconName } from '../primitives/Icon.js'

export interface ActionMenuItemConfig {
  id: string
  label: string
  icon: IconName
  iconFilled?: boolean
  onAction: () => void
  variant?: 'default' | 'danger'
  disabled?: boolean
  hint?: string
}

interface ActionMenuProps {
  label: string
  icon?: IconName
  items: ActionMenuItemConfig[]
  triggerVariant?: 'primary' | 'subtle'
  ariaLabel?: string
}

function MenuItemRow({ node, state, config, showSeparator }: {
  node: Node<object>
  state: TreeState<object>
  config: ActionMenuItemConfig
  showSeparator: boolean
}) {
  const ref = useRef<HTMLLIElement>(null)
  const { menuItemProps, isFocused } = useMenuItem(
    { key: node.key, isDisabled: config.disabled === true },
    state,
    ref
  )
  const { isFocusVisible, focusProps } = useFocusRing()

  const isDanger = config.variant === 'danger'
  const isDisabled = config.disabled === true

  return (
    <>
      {showSeparator && (
        <li className="mx-3 my-1 border-t border-outline/10" role="separator" />
      )}
      <li
        {...menuItemProps}
        {...focusProps}
        ref={ref}
        role="menuitem"
        title={config.hint}
        aria-disabled={isDisabled || undefined}
        className={`
          w-full px-4 py-3 text-left text-sm font-medium
          flex items-center gap-3 outline-none
          ${isDisabled
            ? 'text-outline cursor-not-allowed opacity-60'
            : `cursor-pointer active:scale-[0.98] transition-all ${
                isDanger
                  ? 'text-error hover:bg-error-container'
                  : 'text-accent hover:bg-surface-container-low'
              } ${isFocused || isFocusVisible ? 'bg-surface-container-low' : ''}`
          }
        `}
      >
        <Icon name={config.icon} filled={config.iconFilled} size={20} />
        <span className="flex-grow whitespace-nowrap">{config.label}</span>
        {isDisabled && config.hint && (
          <Icon name="info" size={14} className="text-outline opacity-70" />
        )}
      </li>
    </>
  )
}

interface MenuPosition { top: number; right: number; maxWidth: number }

function MenuPopup({ items, onAction, onClose, menuProps: externalMenuProps, triggerRef }: {
  items: ActionMenuItemConfig[]
  onAction: (key: Key) => void
  onClose: () => void
  menuProps: ReturnType<typeof useMenuTrigger>['menuProps']
  triggerRef: React.RefObject<HTMLButtonElement | null>
}) {
  const overlayRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLUListElement>(null)
  const [position, setPosition] = useState<MenuPosition | null>(null)

  useLayoutEffect(() => {
    const trigger = triggerRef.current
    if (!trigger) return
    const computePosition = () => {
      const rect = trigger.getBoundingClientRect()
      const gap = 8
      const edgeMargin = 16
      const right = Math.max(edgeMargin, window.innerWidth - rect.right)
      const maxWidth = window.innerWidth - right - edgeMargin
      setPosition({ top: rect.bottom + gap, right, maxWidth })
    }
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

  const treeState = useTreeState({
    children,
    selectionMode: 'none' as const,
    disabledKeys,
  })

  const { menuProps } = useMenu(
    { ...externalMenuProps, onAction },
    treeState,
    menuRef
  )

  if (typeof document === 'undefined') return null
  if (!position) return null

  return createPortal(
    <div
      {...overlayProps}
      ref={overlayRef}
      style={{ position: 'fixed', top: position.top, right: position.right, maxWidth: position.maxWidth, zIndex: 60 }}
    >
      <DismissButton onDismiss={onClose} />
      <ul
        {...menuProps}
        ref={menuRef}
        className="min-w-[10rem] bg-surface-container-lowest rounded-xl shadow-[0_8px_18px_-4px_rgba(0,0,0,0.4)] dark:shadow-[0_8px_18px_-4px_rgba(0,0,0,0.6)] overflow-hidden outline-none py-1"
      >
        {[...treeState.collection].map((node, index) => {
          const config = items.find(i => i.id === node.key)
          if (!config) return null

          const showSeparator = config.variant === 'danger' && index > 0

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
    </div>,
    document.body,
  )
}

export default function ActionMenu({ label, icon, items, triggerVariant, ariaLabel }: ActionMenuProps) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const state = useMenuTriggerState({})
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

  const isSubtle = triggerVariant === 'subtle'
  const triggerClass = isSubtle
    ? `w-10 h-10 rounded-full flex items-center justify-center hover:bg-surface-container-high active:scale-95 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30 ${isPressed ? 'scale-95' : ''}`
    : `flex items-center gap-2 bg-primary text-on-primary rounded-xl px-5 py-2.5 font-headline font-bold text-sm shadow-lg shadow-primary/10 transition-all hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30 ${isPressed ? 'scale-95' : ''}`

  return (
    <div className="relative">
      <button
        {...buttonProps}
        ref={triggerRef}
        aria-label={ariaLabel ?? label}
        className={triggerClass}
      >
        {isSubtle ? (
          <Icon name={icon ?? 'more_vert'} size={22} className="text-secondary" />
        ) : (
          <>
            {icon && <Icon name={icon} size={20} />}
            {label}
            <Icon
              name="keyboard_arrow_down"
              size={20}
              className={`transition-transform ${state.isOpen ? 'rotate-180' : ''}`}
            />
          </>
        )}
      </button>

      {state.isOpen && (
        <MenuPopup items={items} onAction={handleAction} onClose={() => state.close()} menuProps={menuProps} triggerRef={triggerRef} />
      )}
    </div>
  )
}
