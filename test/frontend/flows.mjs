import { ad } from './agent.mjs'
import { findNode, flatten } from './tree.mjs'
import { POLL_MS, PANEL_TRIES, PANEL_WAIT_MS } from './ax-support.mjs'

// The app-flow half of Instance: onboarding, navigation and the mount/share verbs. Knows Mirall's
// screens; knows nothing about process lifecycle. Applied as a mixin so the scenarios keep one
// object with one surface.
export const withFlows = (Base) => class extends Base {
  async onboard() {
    await this.waitText('Welcome to Mirall', 45000)
    await this.type({ role: 'textfield' }, this.name)
    await this.click({ role: 'button', name: 'Continue' })
    await this.waitText('Create Space', 30000)
  }

  // Second onboarding step: the connectivity check. Its primary control is disabled
  // while the probe runs, and its label depends on the verdict — on the local testnet
  // there is no canary target, so the neutral "Continue" is the expected path.
  // Same `actionable` lens as nodeValue(): a control's disabled state is meaningless
  // on the label that shares its name, and a statictext never carries `disabled` —
  // so matching the label would quietly report an actually-disabled control as
  // enabled, which is a false PASS rather than a visible failure.

  async createSpaceOnly(name = 'Aurora') {
    await this.click({ role: 'button', name: 'Create Space' })
    await this.waitText('Create a New Space')
    await this.type({ role: 'textfield' }, name)
    await this.click({ role: 'button', name: 'Initialize Space' })
    await this.waitText('Space Created')
    await this.click({ role: 'button', name: 'Done' })
    await this.waitText(name)
  }

  async openSettings() {
    await this.click({ name: 'Settings' })
    await this.waitText('Manage your experience', 8000)
  }

  async gotoSettings(section) {
    await this.openSettings()
    await this.click({ name: section })
  }

  async openAccount() {
    // Role-scoped: the page's own <h1> is named "Profile" too, so an unscoped name match can
    // resolve to the heading instead of the TopNav avatar button.
    await this.click({ role: 'button', name: 'Profile' })
    await this.waitText('Your profile', 8000)
  }

  async openNetworkStatus() {
    await this.openAccount()
    await this.click({ role: 'button', contains: 'Connection' })
    await this.waitText('Network status', 8000)
  }

  async openNetworkDiagnostics() {
    await this.openNetworkStatus()
    await this.click({ role: 'button', name: 'Diagnostics' })
    await this.waitText('If we ask you for details', 8000)
  }

  async openNetworkAdvanced() {
    await this.openNetworkStatus()
    await this.click({ role: 'button', name: 'Advanced details' })
    await this.waitText('The raw values behind your connection', 8000)
  }

  async openActivityLog() {
    await this.openAccount()
    await this.click({ role: 'button', name: 'Activity Log' })
    await this.waitText('A record of what happened', 8000)
  }

  async openJoinModal() {
    await this.click({ role: 'button', name: 'Join Space' })
    await this.waitText('Join a Space', 8000)
  }

  async openInviteModal() {
    await this.click({ name: 'Invite', last: true })
    await this.waitText('Invite to Space', 8000)
  }

  async openEditSpace() {
    await this.click({ name: 'More' })
    await new Promise((r) => setTimeout(r, POLL_MS))
    await this.click({ name: 'Edit Space' })
    await this.waitText('Edit Space', 8000)
  }

  async back() {
    await this.click({ name: 'Back' })
  }

  // Drive a native NSOpenPanel (file or folder) belonging to THIS instance via Go-to-folder; it
  // surfaces as a window titled "Open" with our pid. `trigger` is fired HERE, not by the caller,
  // because it can be LOST: an accelerator goes to whichever process is frontmost, and the File-menu
  // items behind ⌘U / ⌘⇧U are inert until menu:context-changed lands. A panel that is coming takes
  // ~1.6 s, so a multi-second empty wait means the trigger was lost, not late — re-fire it (safe:
  // only while NO panel is up) instead of stretching the deadline.

  async nativeChoosePath(absPath, { trigger = null } = {}) {
    const findPanel = async () => (await ad(['list-windows'])).data.find(
      (w) => w.app_name === 'Electron' && w.title === 'Open' && w.pid === this.pid,
    )
    let openWin = null
    // Same ~20s total budget as a single long wait, split into attempts so a lost
    // trigger gets another chance instead of burning the whole budget on one.
    for (let attempt = 0; attempt < PANEL_TRIES && !openWin; attempt++) {
      if (attempt) console.error(`[${this.name}] no Open panel after ${PANEL_WAIT_MS}ms — re-firing trigger (${attempt + 1}/${PANEL_TRIES})`)
      if (trigger) await trigger()
      const deadline = Date.now() + PANEL_WAIT_MS
      while (Date.now() < deadline) {
        openWin = await findPanel()
        if (openWin) break
        await new Promise((r) => setTimeout(r, POLL_MS))
      }
      // Without a trigger to re-fire there is nothing a second pass would change.
      if (!trigger) break
    }
    if (!openWin) throw new Error(`${this.name}: native Open panel not found`)
    await ad(['focus-window', '--window-id', openWin.id], { allowError: true })
    await ad(['press', 'cmd+shift+g'])
    await new Promise((r) => setTimeout(r, 250))
    // Re-resolve the field each attempt and set it in a single op (set-value is
    // absolute — no separate clear, which would stale the ref). Verify by read-back.
    let ok = false
    for (let i = 0; i < 15 && !ok; i++) {
      const sheet = (await this.ad(['snapshot', '--app', 'Electron', '--surface', 'sheet'])).data
      const tf = findNode(sheet.tree ?? sheet, { role: 'textfield' })
      if (tf?.ref) {
        await this.ad(['set-value', tf.ref, absPath], { allowError: true })
        const v = (await this.ad(['get', tf.ref, '--property', 'value'], { allowError: true })).data?.value
        if (v === absPath) ok = true
      }
      if (!ok) await new Promise((r) => setTimeout(r, POLL_MS))
    }
    if (!ok) throw new Error(`${this.name}: could not set Go-to-folder path`)
    await ad(['press', 'return'])
    await new Promise((r) => setTimeout(r, 300))
    await ad(['press', 'return'])
    await new Promise((r) => setTimeout(r, 400))
    // The two returns (commit Go-to sheet, then Open) can race the sheet animation and
    // silently select NOTHING — the panel stays up, the scenario "passes" this step, and
    // the miss only surfaces a minute later as "peer never saw the file". Verify the panel
    // actually closed, re-pressing return while it lingers.
    const closedBy = Date.now() + 10000
    while (Date.now() < closedBy) {
      const still = (await ad(['list-windows'])).data.find(
        (w) => w.app_name === 'Electron' && w.title === 'Open' && w.pid === this.pid,
      )
      if (!still) return
      await ad(['focus-window', '--window-id', still.id], { allowError: true })
      await ad(['press', 'return'])
      await new Promise((r) => setTimeout(r, 400))
    }
    throw new Error(`${this.name}: native Open panel did not close after selection`)
  }

  // Add a loose file (mod+u opens the file picker) and pick it via the panel.

  async addFile(absPath) {
    await this.nativeChoosePath(absPath, { trigger: () => this.press('cmd+u') })
  }

  // Shared tail of the AddFolder / MirrorFolder modals: wait for "Next: Preview"
  // to enable (validation is async — advisories are now non-blocking warning text,
  // nothing to acknowledge), advance to the ScanPreviewModal, and confirm.

  async _confirmPreview(createLabel, previewText) {
    await new Promise((r) => setTimeout(r, 400))
    for (let i = 0; i < 20; i++) {
      const next = flatten(await this.snap()).find(
        (n) => n.role === 'button' && (n.name === 'Next: Preview' || n.description === 'Next: Preview'),
      )
      if (next && !(next.states ?? []).includes('disabled')) break
      await new Promise((r) => setTimeout(r, POLL_MS))
    }
    await this.click({ role: 'button', name: 'Next: Preview' })
    await this.waitText(previewText, 20000)
    await this.click({ role: 'button', name: createLabel, last: true })
  }

  async addOwnedFolder(absDir) {
    await this.nativeChoosePath(absDir, { trigger: () => this.press('cmd+shift+u') })
    await this.waitText('Add Folder', 20000)
    // Overlay is the only content mode now — the modal has no Eager/In-place picker,
    // so a share always publishes in place via the overlay backend.
    await this._confirmPreview('Add Folder', 'Upload')
  }

  // Open Add Folder and select a path, stopping on the edit step (no confirm) so
  // the Folder Share segmented control can be inspected. Returns once the modal
  // is up; caller asserts on segment presence then dismisses.

  async openAddFolderModal(absDir) {
    await this.nativeChoosePath(absDir, { trigger: () => this.press('cmd+shift+u') })
    await this.waitText('Add Folder', 20000)
    await new Promise((r) => setTimeout(r, 300))
  }

  // Open Add Folder, pick a path, advance to the ScanPreviewModal and STOP there (no confirm), so
  // the preview's own verdict can be inspected — e.g. the refusal for a folder over the file limit.

  async openAddFolderPreview(absDir) {
    await this.nativeChoosePath(absDir, { trigger: () => this.press('cmd+shift+u') })
    await this.waitText('Add Folder', 20000)
    await new Promise((r) => setTimeout(r, 400))
    for (let i = 0; i < 20; i++) {
      const next = flatten(await this.snap()).find(
        (n) => n.role === 'button' && (n.name === 'Next: Preview' || n.description === 'Next: Preview'),
      )
      if (next && !(next.states ?? []).includes('disabled')) break
      await new Promise((r) => setTimeout(r, POLL_MS))
    }
    await this.click({ role: 'button', name: 'Next: Preview' })
  }

  // Open Add Folder and select a path, but stop on the edit step (no confirm) so
  // a validation rejection surfaces. Returns once async validation has run.

  async openAddFolderAndPick(absDir) {
    await this.nativeChoosePath(absDir, { trigger: () => this.press('cmd+shift+u') })
    await this.waitText('Add Folder', 20000)
    await new Promise((r) => setTimeout(r, 600))
  }

  // Mirror a browse share to disk. Opens the share card's own ⋯ menu (it renders
  // after the header "More", so match the last one), Browse to mirrorDir, confirm.

  async mirrorShare(mirrorDir) {
    await this.click({ name: 'More', last: true })
    await new Promise((r) => setTimeout(r, POLL_MS))
    await this.click({ name: 'Mirror to Disk…' })
    await this.waitText('to Disk', 20000)
    await this.nativeChoosePath(mirrorDir, { trigger: () => this.click({ role: 'button', name: 'Browse…' }) })
    await this._confirmPreview('Start Mirroring', 'Download')
  }

  // Mirror's counterpart to openAddFolderPreview: advance to the ScanPreviewModal and STOP there,
  // so the preview's own verdict can be inspected before committing.

  async openMirrorPreview(mirrorDir) {
    await this.click({ name: 'More', last: true })
    await new Promise((r) => setTimeout(r, POLL_MS))
    await this.click({ name: 'Mirror to Disk…' })
    await this.waitText('to Disk', 20000)
    await this.nativeChoosePath(mirrorDir, { trigger: () => this.click({ role: 'button', name: 'Browse…' }) })
    await new Promise((r) => setTimeout(r, 400))
    for (let i = 0; i < 20; i++) {
      const next = flatten(await this.snap()).find(
        (n) => n.role === 'button' && (n.name === 'Next: Preview' || n.description === 'Next: Preview'),
      )
      if (next && !(next.states ?? []).includes('disabled')) break
      await new Promise((r) => setTimeout(r, POLL_MS))
    }
    await this.click({ role: 'button', name: 'Next: Preview' })
    await this.waitText('Download', 20000)
  }

  async unmountShare() {
    await this.click({ name: 'More', last: true })
    await new Promise((r) => setTimeout(r, POLL_MS))
    await this.click({ name: 'Unmount Mirror' })
  }

  // Open the owned share card's ⋯ menu and confirm Delete Folder. The menu item
  // and the modal's confirm button share the label "Delete Folder", so the
  // confirm targets the last match (the modal button, rendered after).

  async deleteShare() {
    await this.click({ name: 'More', last: true })
    await new Promise((r) => setTimeout(r, POLL_MS))
    await this.click({ name: 'Delete Folder' })
    await this.waitText('will no longer see', 15000)
    await this.click({ role: 'button', name: 'Delete Folder', last: true })
  }

  async pauseMirror() {
    await this.click({ name: 'More', last: true })
    await new Promise((r) => setTimeout(r, POLL_MS))
    await this.click({ name: 'Pause syncing' })
  }

  async resumeMirror() {
    await this.click({ name: 'More', last: true })
    await new Promise((r) => setTimeout(r, POLL_MS))
    await this.click({ name: 'Resume syncing' })
  }

  // Open a share's FolderScreen from the space view (the card's "Open <name>"
  // button). FolderScreen lists files as a flat, recursive set of relPaths, so a
  // nested file shows as a "sub/dir/file.txt" row.

  async openFolder(name) {
    await this.click({ name: 'Open ' + name })
    // The People tile is the one thing every role renders immediately — the file list may still be
    // loading and the Folder tile waits on its totals.
    await this.waitText('People', 15000)
  }

  // From space-view: More → Manage Storage → StorageSettings. "Manage Storage"
  // lives in the space *header* menu, so target the first "More" — once a folder
  // is shared, the share card adds its own "More" (the last one), which has no
  // Manage Storage. (Header-level siblings openEditSpace/leaveSpace match first too.)

  async openManageStorage() {
    await this.click({ name: 'More' })
    await new Promise((r) => setTimeout(r, POLL_MS))
    await this.click({ name: 'Manage Storage' })
    await this.waitText('Download Folder', 10000)
  }

  // Leave the current space via the More menu → Leave Space → confirm.

  async leaveSpace() {
    // The menu trigger has aria-haspopup → AX exposes it as a popup button, not
    // role "button", so match by name only.
    await this.click({ name: 'More' })
    await new Promise((r) => setTimeout(r, POLL_MS))
    await this.click({ name: 'Leave Space' })
    await this.waitText('Leave')
    await this.click({ role: 'button', name: 'Leave Space', last: true })
    await this.waitText('Create Space', 30000)
  }
}
