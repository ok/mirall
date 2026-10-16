// ActionMenu's single-choice shape (LOCAL/dev-machine only — spawns a real Electron GUI process).
// Mounts the REAL <ActionMenu> as the Download-to menu: a heading, the current folder checked, an
// offline folder disabled, another folder, and Choose Folder… under a rule. Opens it from the
// keyboard and asserts what assistive tech reads: the folders are radio items, exactly one checked,
// and Choose Folder… is a plain menu item with no checked state — it is an action, not a choice
// (REGRESSION (FIX-DLTO-R15: Choose Folder… read as an unchecked radio item)); a heading that never
// takes focus, each item's second line as its description, ArrowDown skipping the disabled item,
// and Esc handing focus back to the trigger. The macOS AX tree carries neither aria-describedby nor
// the radio role reliably, so the DOM is the layer that can.
//
// The menus that were there before (a More menu, a filter menu) are mounted beside it and must
// render as they did: plain menu items, no checked state, no heading, the same trigger tokens.
import './harness-bootstrap.js'
import { createRoot } from 'react-dom/client'
import '../../src/renderer/platform/i18n.js'
import ActionMenu, { type ActionMenuItemConfig } from '../../src/renderer/components/primitives/ActionMenu.js'

interface ChoiceResults {
  opened: boolean
  roles: string[]
  /** Each item's aria-checked attribute; null where the item carries none. */
  checkedAttrs: (string | null)[]
  checked: string[]
  headingText: string
  headingFocusable: boolean
  descriptions: string[]
  focusAfterOpen: string
  focusAfterDown: string
  closedOnEsc: boolean
  focusOnTrigger: boolean
  /** The popup's width and whether the long path's line is cut short inside it. */
  menuWidth: number
  longPathTruncated: boolean
  /** Each item's leading icon width: a truncating line must not squeeze it. */
  iconWidths: number[]
}

interface LegacyResults {
  id: string
  opened: boolean
  roles: string[]
  anyChecked: boolean
  anyDescribed: boolean
  heading: boolean
  triggerClass: string
  expectedTriggerClass: string
  popupMinWidth: boolean
  itemHeights: number[]
}

interface Results {
  pass: boolean
  error: string | null
  choice: ChoiceResults | null
  legacy: LegacyResults[]
}

declare global {
  interface Window { __results: Results }
}

const noop = () => {}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// A path far wider than the popup may grow: it truncates instead of widening the menu.
const LONG_PATH = '~/Code/_worktrees/mirall-app/a-very-long-worktree-name-for-a-plan/test/frontend/.work/Handover'
const FOLDERS: ActionMenuItemConfig[] = [
  { id: 'cur', label: 'Downloads', description: '~/Downloads', icon: 'check', checked: true, onAction: noop },
  { id: 'off', label: 'Clients', description: '/Volumes/Archive/Clients · drive not connected', icon: 'folder', checked: false, disabled: true, onAction: noop },
  { id: 'other', label: 'Handover', description: LONG_PATH, icon: 'folder', checked: false, onAction: noop },
  { id: 'choose', label: 'Choose Folder…', icon: 'folder_open', separatorBefore: true, onAction: noop },
]
const MORE: ActionMenuItemConfig[] = [
  { id: 'rename', label: 'Rename', icon: 'edit', onAction: noop },
  { id: 'remove', label: 'Remove', icon: 'delete', variant: 'danger', onAction: noop },
]
const FILTER: ActionMenuItemConfig[] = [
  { id: 'all', label: 'All Spaces', onAction: noop },
  { id: 'a', label: 'Aurora', onAction: noop },
]

// The trigger tokens each existing variant rendered before the single-choice shape was added.
const SUBTLE_CLASS = 'w-10 h-10 rounded-full flex items-center justify-center control-hover active:scale-95 transition-all focus-ring '
const NEUTRAL_CLASS = 'flex items-center gap-2 rounded-xl px-5 py-2.5 font-headline font-bold text-sm transition-all focus-ring bg-surface-control text-on-surface-variant hover:bg-surface-control-hover '

createRoot(document.getElementById('root') as HTMLElement).render(
  <div className="p-8 flex gap-8 bg-surface min-h-screen">
    <div data-case="choice">
      <ActionMenu triggerVariant="subtle" icon="download" label="Download to…" heading="Download to" popupWidthClass="min-w-[17rem] max-w-[22rem]" items={FOLDERS} />
    </div>
    <div data-case="more">
      <ActionMenu triggerVariant="subtle" label="More actions" icon="more_vert" items={MORE} />
    </div>
    <div data-case="filter">
      <ActionMenu triggerVariant="neutral" label="All Spaces" ariaLabel="Space: All Spaces" items={FILTER} />
    </div>
  </div>,
)

const key = (el: Element | null, k: string) =>
  el?.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))

function trigger(caseId: string): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(`[data-case="${caseId}"] button`)
}

// Focus the trigger first, so the popup's focus scope has something to restore.
async function open(caseId: string): Promise<HTMLUListElement | null> {
  const t = trigger(caseId)
  t?.focus()
  key(t, 'ArrowDown')
  await sleep(150)
  return document.querySelector<HTMLUListElement>('ul[role=menu]')
}

const itemsOf = (menu: HTMLUListElement) => Array.from(menu.querySelectorAll<HTMLElement>('li[role^=menuitem]'))
const label = (el: Element | null) => (el instanceof HTMLElement ? el.querySelector('span span')?.textContent ?? el.textContent ?? '' : '')

async function close(): Promise<void> {
  key(document.activeElement, 'Escape')
  await sleep(150)
}

async function probeChoice(): Promise<ChoiceResults | null> {
  const menu = await open('choice')
  if (!menu) return null
  const items = itemsOf(menu)
  const heading = menu.querySelector<HTMLElement>('li[role=presentation]')
  heading?.focus()
  const headingFocusable = heading !== null && document.activeElement === heading
  // Put focus back where opening left it before walking the list.
  items[0]?.focus()
  const focusAfterOpen = label(document.activeElement)
  key(document.activeElement, 'ArrowDown')
  await sleep(100)
  const focusAfterDown = label(document.activeElement)
  const longLine = document.getElementById(items[2]?.getAttribute('aria-describedby') ?? '')
  const menuWidth = Math.round(menu.getBoundingClientRect().width)
  const longPathTruncated = longLine !== null && longLine.scrollWidth > longLine.clientWidth
  const iconWidths = items.map((li) => Math.round(li.querySelector('svg, [class*="material"], span')?.getBoundingClientRect().width ?? -1))
  const descriptions = items.map((li) => (li.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? `«${id} missing»`).join(' '))
  const result = {
    opened: true,
    roles: items.map((li) => li.getAttribute('role') ?? ''),
    checkedAttrs: items.map((li) => li.getAttribute('aria-checked')),
    checked: items.filter((li) => li.getAttribute('aria-checked') === 'true').map(label),
    headingText: heading?.textContent ?? '',
    headingFocusable,
    descriptions,
    focusAfterOpen,
    focusAfterDown,
    closedOnEsc: false,
    focusOnTrigger: false,
    menuWidth,
    longPathTruncated,
    iconWidths,
  }
  await close()
  result.closedOnEsc = document.querySelector('ul[role=menu]') === null
  result.focusOnTrigger = document.activeElement === trigger('choice')
  return result
}

async function probeLegacy(id: string, expectedTriggerClass: string): Promise<LegacyResults> {
  const triggerClass = trigger(id)?.className ?? ''
  const menu = await open(id)
  const items = menu ? itemsOf(menu) : []
  const result = {
    id,
    opened: menu !== null,
    roles: items.map((li) => li.getAttribute('role') ?? ''),
    anyChecked: items.some((li) => li.hasAttribute('aria-checked')),
    anyDescribed: items.some((li) => li.hasAttribute('aria-describedby')),
    heading: menu?.querySelector('li[role=presentation]') != null,
    triggerClass,
    expectedTriggerClass,
    popupMinWidth: menu?.classList.contains('min-w-[10rem]') === true,
    itemHeights: items.map((li) => Math.round(li.getBoundingClientRect().height * 100) / 100),
  }
  await close()
  return result
}

// The folders are the choice; Choose Folder… is the one action among them.
const EXPECTED_ROLES = ['menuitemradio', 'menuitemradio', 'menuitemradio', 'menuitem']
const EXPECTED_CHECKED = ['true', 'false', 'false', null]

function choicePasses(c: ChoiceResults | null): boolean {
  return c !== null &&
    c.roles.join() === EXPECTED_ROLES.join() &&
    JSON.stringify(c.checkedAttrs) === JSON.stringify(EXPECTED_CHECKED) &&
    c.checked.length === 1 && c.checked[0] === 'Downloads' &&
    c.headingText === 'Download to' && !c.headingFocusable &&
    c.descriptions[0] === '~/Downloads' && c.descriptions[1].includes('drive not connected') && c.descriptions[2] === LONG_PATH && c.menuWidth <= 352 && c.longPathTruncated && c.iconWidths.every((w) => w === 20) && c.descriptions[3] === '' &&
    c.focusAfterOpen === 'Downloads' && c.focusAfterDown === 'Handover' &&
    c.closedOnEsc && c.focusOnTrigger
}

function legacyPasses(l: LegacyResults): boolean {
  return l.opened && l.roles.length > 0 && l.roles.every((r) => r === 'menuitem') && !l.anyChecked && !l.anyDescribed && !l.heading &&
    l.triggerClass === l.expectedTriggerClass && l.popupMinWidth && l.itemHeights.every((h) => h === 44)
}

async function run(): Promise<Results> {
  await sleep(300)
  const choice = await probeChoice()
  const legacy = [await probeLegacy('more', SUBTLE_CLASS), await probeLegacy('filter', NEUTRAL_CLASS)]
  return { pass: choicePasses(choice) && legacy.every(legacyPasses), error: choice ? null : 'the single-choice menu never opened', choice, legacy }
}

run().then(
  (results) => { window.__results = results },
  (e: unknown) => { window.__results = { pass: false, error: String(e), choice: null, legacy: [] } },
)
