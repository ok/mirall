// REGRESSION harness for dialog error association (LOCAL/dev-machine only — spawns a real Electron
// GUI process, like the agent-desktop frontend suite). A validation error that is only announced
// once, with nothing tying it to the control it is about, leaves the field presenting as valid: a
// person who tabs back to it, or reviews the form before resubmitting, gets nothing. The macOS AX
// tree exposes neither `aria-invalid` nor `aria-describedby`, so the agent-desktop suite cannot see
// this at all — the real DOM is the only layer that can.
//
// Drives the REAL <EditSpaceModal>, <EditFolderModal>, <MountPathField> and <CreateSpaceModal>
// into their failure states and resolves each field's description the way assistive tech does.
import './harness-bootstrap.js'
import { createRoot, type Root } from 'react-dom/client'
import './../../src/renderer/i18n.js'
import EditSpaceModal from './../../src/renderer/components/modals/EditSpaceModal.js'
import EditFolderModal from './../../src/renderer/components/modals/EditFolderModal.js'
import MountPathField from '../../src/renderer/components/path/MountPathField.js'
import CreateSpaceModal from './../../src/renderer/components/modals/CreateSpaceModal.js'
import type { Space } from './../../src/renderer/types.js'

// The download-folder read fails for the whole page, so the space dialog carries BOTH a folder
// error and a name error at once — the case where pointing the name field at "the error" would
// name the wrong control.
window.bridge.getDownloadFolder = () => Promise.reject(new Error('no default folder'))
window.bridge.browseShareFolder = () => Promise.resolve('/tmp/relocated')

const SPACE: Space = {
  spaceId: 'space1',
  name: 'Aurora',
  icon: 'folder',
  topic: 't'.repeat(64),
  created: '2026-01-01',
  members: [],
  favorite: false,
  schemaVersion: 2,
}

interface FieldProbe {
  found: boolean
  invalid: boolean
  describedBy: string
}

interface HarnessResults {
  pass: boolean
  error: string | null
  spaceName: FieldProbe
  spaceFolder: FieldProbe
  folderName: FieldProbe
  folderPath: FieldProbe
  mirrorName: FieldProbe
  mountPath: FieldProbe
  createName: FieldProbe
  // The create-space failure must also be ANNOUNCED, not only associated: it appears after a
  // submit, with nothing else on the form changing.
  createAlert: boolean
  // A submit handler that never catches does not merely fail to report — the rejection escapes as
  // an unhandled promise rejection, which is the same defect seen from the other side.
  unhandled: number
}

declare global {
  interface Window { __results: HarnessResults }
}

let unhandledRejections = 0
window.addEventListener('unhandledrejection', () => { unhandledRejections += 1 })

const MISSING: FieldProbe = { found: false, invalid: false, describedBy: '' }
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// What a screen reader reads off the control: its invalid state, and the text of every element its
// aria-describedby points at, in order.
function probe(el: Element | null): FieldProbe {
  if (!el) return MISSING
  const ids = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)
  const described = ids.map((id) => document.getElementById(id)?.textContent ?? `«${id} missing»`)
  return {
    found: true,
    invalid: el.getAttribute('aria-invalid') === 'true',
    describedBy: described.join(' '),
  }
}

// A controlled React input ignores a plain `.value =`; go through the native setter so React's
// onChange fires and the draft state actually moves.
function typeInto(el: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(el, text)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

// The path row's button is the only one whose whole label is its text; a <Button> carries an icon
// child, so it is matched on a substring.
function pathButton(label: string): HTMLButtonElement | null {
  return Array.from(document.querySelectorAll('button')).find((b) => b.textContent === label) ?? null
}

function saveButton(): HTMLButtonElement | null {
  return labelledButton('Save Changes')
}

function labelledButton(text: string): HTMLButtonElement | null {
  return Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes(text)) ?? null
}

// A mapped code, so the save failure reads as its own sentence rather than the generic one the
// folder read falls back to — the two must stay distinguishable from the field they hang off.
const rejects = () => Promise.reject(Object.assign(new Error('boom'), { code: 'SHARE_NAME_COLLISION' }))
// The create path fails for a reason that is nobody's typing: the worker cannot service the
// request. It still has to reach the person who pressed the button.
const rejectsUnavailable = () => Promise.reject(Object.assign(new Error('worker is still starting'), { code: 'WORKER_UNAVAILABLE' }))
const noop = () => {}

async function run(root: Root): Promise<HarnessResults> {
  const results: HarnessResults = {
    pass: false,
    error: null,
    spaceName: MISSING,
    spaceFolder: MISSING,
    folderName: MISSING,
    folderPath: MISSING,
    mirrorName: MISSING,
    mountPath: MISSING,
    createName: MISSING,
    createAlert: false,
    unhandled: 0,
  }

  root.render(<EditSpaceModal space={SPACE} onSave={rejects} onClose={noop} />)
  await sleep(300)
  const spaceName = document.getElementById('edit-space-name') as HTMLInputElement
  typeInto(spaceName, 'Aurora Renamed')
  await sleep(50)
  saveButton()?.click()
  await sleep(300)
  results.spaceName = probe(document.getElementById('edit-space-name'))
  // With the read failed there is no path to show, so the row offers a first pick.
  results.spaceFolder = probe(pathButton('Browse…'))

  root.render(
    <EditFolderModal
      key="owner"
      isOwner
      canRelocate
      name="Photos"
      ownerName="Vhinz"
      mountPath="/tmp/photos"
      onRename={rejects}
      onRelocate={rejects}
      onClose={noop}
    />,
  )
  await sleep(300)
  typeInto(document.getElementById('edit-folder-name') as HTMLInputElement, 'Pictures')
  pathButton('Change')?.click()
  await sleep(200)
  saveButton()?.click()
  await sleep(300)
  results.folderName = probe(document.getElementById('edit-folder-name'))
  results.folderPath = probe(pathButton('Change'))

  // A mirror's name belongs to the owner: the field is read-only and its note is the only
  // description it has, so the joined value must not have swallowed it.
  root.render(
    <EditFolderModal
      key="mirror"
      isOwner={false}
      canRelocate
      name="Photos"
      ownerName="Vhinz"
      mountPath="/tmp/photos"
      onRename={rejects}
      onRelocate={rejects}
      onClose={noop}
    />,
  )
  await sleep(300)
  results.mirrorName = probe(document.getElementById('edit-folder-name'))

  root.render(
    <div className="p-4">
      <MountPathField id="mount-path" label="Folder on this Mac" path="/tmp/pick" error="That folder is inside another share." onBrowse={noop} />
    </div>,
  )
  await sleep(300)
  results.mountPath = probe(pathButton('Change'))

  // REGRESSION (#279): a failed space creation reported nothing at all — no catch, no error state,
  // no surface to render one into. The button simply went back to "Initialize Space".
  root.render(<CreateSpaceModal isOpen onClose={noop} onCreate={rejectsUnavailable} />)
  await sleep(300)
  typeInto(document.getElementById('create-space-name') as HTMLInputElement, 'Aurora')
  await sleep(50)
  labelledButton('Initialize Space')?.click()
  await sleep(300)
  results.createName = probe(document.getElementById('create-space-name'))
  results.createAlert = document.getElementById('create-space-error')?.getAttribute('role') === 'alert'
  results.unhandled = unhandledRejections

  results.pass =
    results.spaceName.invalid &&
    results.spaceName.describedBy.includes('Could not save changes') &&
    results.spaceName.describedBy.includes('already uses that name') &&
    !results.spaceName.describedBy.includes('Something went wrong') &&
    results.spaceFolder.describedBy.includes('Download Folder') &&
    results.spaceFolder.describedBy.includes('Something went wrong') &&
    results.folderName.invalid &&
    results.folderName.describedBy.includes('rename this folder') &&
    !results.folderName.describedBy.includes('change the location') &&
    results.folderPath.describedBy.includes('change the location') &&
    !results.mirrorName.invalid &&
    results.mirrorName.describedBy.includes('Vhinz') &&
    results.mountPath.describedBy.includes('Folder on this Mac') &&
    results.mountPath.describedBy.includes('inside another share') &&
    results.createName.invalid &&
    results.createName.describedBy.includes("background service isn't available") &&
    results.createAlert &&
    results.unhandled === 0

  return results
}

const root = createRoot(document.getElementById('root') as HTMLElement)
run(root).then(
  (results) => { window.__results = results },
  (e: unknown) => {
    window.__results = {
      pass: false,
      error: String(e),
      spaceName: MISSING,
      spaceFolder: MISSING,
      folderName: MISSING,
      folderPath: MISSING,
      mirrorName: MISSING,
      mountPath: MISSING,
      createName: MISSING,
      createAlert: false,
      unhandled: unhandledRejections,
    }
  },
)
