import { spawn } from 'node:child_process'
import { rmSync, openSync, closeSync } from 'node:fs'
import path from 'node:path'
import { ad, withRetry, RETRYABLE } from './agent.mjs'
import { findNode, allText, flatten } from './tree.mjs'
import { tile } from './layout.mjs'
import { workDir } from './paths.mjs'

const REPO = path.resolve(import.meta.dirname, '../..')

// `electron-forge start` runs unbranded, so our dev windows surface under
// app_name "Electron" (real Electron apps like Signal/Keet report their
// productName). We deliberately do NOT match on `title`: list-windows fills
// `title` from CGWindow's kCGWindowName, which is only populated when the
// caller holds Screen Recording permission — without it the title falls back
// to the owner name ("Electron"), not the document title ("Mirall"), and the
// whole suite stalls for 90s per launch waiting for a window that never
// matches. Snapshots only need Accessibility, so keying off app_name alone
// drops that second, fragile permission dependency. Native NSOpenPanel /
// NSSavePanel sheets share our pid and app_name but carry their own titles, so
// exclude them by title to keep pid-based re-resolution on the main window.
const NATIVE_PANEL_TITLES = new Set(['Open', 'Save'])

// agent-desktop 0.8.x widened `list-windows`: one dev Electron app now reports the
// real window plus ~8 helper windows that are titled "Electron", carry the same
// pid, and are NOT exposed through accessibility (snapshotting one returns
// ACTION_NOT_SUPPORTED). 0.4.x listed only the real window, so `launch()` could
// take the last fresh entry and always land on it. Ordering across those entries is
// not guaranteed, so the last fresh window is now sometimes a phantom — which is
// why this presented as most-but-not-all scenarios failing at their first snapshot.
// `visible` separates them cleanly: only the real window reports true. It is also
// the property we actually depend on, since an off-screen or unpainted window has
// no usable AX tree either.

// Poll interval for the harness's own wait loops. Each iteration does a ~0.4s
// snapshot, so the snapshot dominates and a tight sleep just trims dead time
// between polls without spamming the AX system.
const POLL_MS = 150

// Attempts (and per-attempt wait) for getting a native Open panel on screen; the
// product is the old single 20s budget, so a lost trigger costs no extra wall
// clock on the happy path. See nativeChoosePath.
const PANEL_TRIES = 3
const PANEL_WAIT_MS = 7000
async function mirallWindows() {
  const { data } = await ad(['list-windows'])
  return data
    .filter((w) => w.app_name === 'Electron' && w.visible === true && !NATIVE_PANEL_TITLES.has(w.title))
    .map((w) => ({ id: w.id, pid: w.pid }))
}

export class Instance {
  constructor({ name, bootstrap = null, slot = 0, total = 2, flags = null }) {
    this.name = name
    this.bootstrap = bootstrap
    this.slot = slot
    this.total = total
    // Merged over feature-flags.json via MIRALL_FEATURE_FLAGS.
    this.flags = { ...(flags || {}) }
    this.store = workDir(`store-${name}-`)
    this.downloadFolder = workDir(`dl-${name}-`)
    this.proc = null
    this.windowId = null
    this.pid = null
    // agent-desktop 0.3.0+ resolves a ref against the latest snapshot saved in its
    // --session namespace, so snapshot-then-act across separate CLI processes only
    // stays coherent when both share one session. Give each Instance its own
    // namespace (id sanitised to [A-Za-z0-9_-], <=64 chars) so two peers' snapshots
    // never clobber each other's latest. this.ad threads the session onto snapshots
    // and ref-consuming actions (the calls whose ref must resolve cross-process).
    this.session = `mirall-${name}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64)
    this.ad = (a, opts = {}) => ad(a, { session: this.session, ...opts })
  }

  async launch({ onboard = true } = {}) {
    const before = new Set((await mirallWindows()).map((w) => w.id))
    const env = {
      ...process.env,
      MIRALL_NO_DEVTOOLS: '1',
      MIRALL_FORCE_A11Y: '1',
      MIRALL_VERBOSE: '1',
      MIRALL_DOWNLOAD_FOLDER: this.downloadFolder,
      MIRALL_WINDOW_BOUNDS: JSON.stringify(tile(this.slot, this.total)),
    }
    if (this.bootstrap) env.MIRALL_DHT_BOOTSTRAP = JSON.stringify(this.bootstrap)
    if (this.flags) env.MIRALL_FEATURE_FLAGS = JSON.stringify(this.flags)
    this.logPath = `/tmp/mirall-fe-${this.name}.log`
    const logFd = openSync(this.logPath, 'w')
    this.proc = spawn(
      'npx',
      ['electron-forge', 'start', '--', '--no-updates', '--storage', this.store],
      { cwd: REPO, env, detached: true, stdio: ['ignore', logFd, logFd] },
    )
    // The child dup'd its own copy of the log fd; close ours so 82 sequential
    // launches in a full run don't leak 82 descriptors in the test runner.
    closeSync(logFd)

    const deadline = Date.now() + 90000
    while (Date.now() < deadline) {
      const fresh = (await mirallWindows()).filter((w) => !before.has(w.id))
      if (fresh.length) {
        this.windowId = fresh[fresh.length - 1].id
        this.pid = fresh[fresh.length - 1].pid
        break
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    if (!this.windowId) throw new Error(`${this.name}: Mirall window never appeared`)
    console.error(`[${this.name}] before=[${[...before].join(',')}] resolved=${this.windowId}`)
    // Raise the new window so Chromium paints it; a backgrounded renderer never
    // builds its AX tree, which leaves snapshots empty. Unconditional (not via
    // focus()) because focus() no-ops for single instances — the one-time initial
    // raise must still happen so the renderer paints and snapshots aren't empty.
    await ad(['focus-window', '--window-id', this.windowId], { allowError: true })
    await this._waitForAx()
    if (onboard) await this.onboard()
    return this
  }

  // A window appears in list-windows as soon as the OS has it, but Chromium builds
  // web-content accessibility lazily per renderer process, so for a short window it
  // is listed, painted, and still unable to answer an AX query. agent-desktop 0.4.x
  // papered over that by returning an empty tree — the scenarios' own waitText loops
  // absorbed it — while 0.8.x fails the snapshot outright with ACTION_NOT_SUPPORTED
  // ("exists but is not exposed through accessibility"). It is a race, not a hard
  // break: on a fast launch the renderer wins and the scenario passes, which is why
  // it presents as most-but-not-all scenarios failing at their first step. Block
  // here until the window actually answers, so every scenario starts from a window
  // that is known to be drivable.
  async _waitForAx(timeout = 30000) {
    const deadline = Date.now() + timeout
    let last = null
    while (Date.now() < deadline) {
      try {
        await this.snap({ interactive: true })
        return
      } catch (e) {
        if (e.code !== 'ACTION_NOT_SUPPORTED' && e.code !== 'WINDOW_NOT_FOUND') throw e
        last = e
        await new Promise((r) => setTimeout(r, POLL_MS))
      }
    }
    throw new Error(`${this.name}: window ${this.windowId} never exposed an AX tree in ${timeout}ms (last: ${last?.code})`)
  }

  // `interactive` drops static-text / non-actionable nodes (-i) and collapses
  // unnamed wrapper nodes (--compact). Use it for ref resolution: _ref only ever
  // returns a node that has a ref (an interactive element), and those survive -i
  // unchanged, so the first/last match is identical to the full tree — just a
  // smaller payload to serialize/parse. Text/state assertions keep the full tree.
  async snap({ interactive = false } = {}) {
    const lens = interactive ? ['-i', '--compact'] : []
    // agent-desktop 0.7.0+ returns ok:true with data.complete=false when the AX
    // walk exhausts its budget (it used to be a TIMEOUT error, which this
    // harness surfaced as a retryable throw). A truncated tree is indistinguishable
    // from a missing element once it reaches findNode/allText, so it would show up
    // as unexplained "no element {...}" flake. Reject it here instead. `complete`
    // is absent on <0.7.0, and `=== false` leaves that case untouched.
    const take = async () => {
      const { data } = await this.ad(['snapshot', '--window-id', this.windowId, '--max-depth', '40', ...lens])
      if (data.complete === false) {
        throw Object.assign(new Error(`${this.name}: AX snapshot truncated (window ${this.windowId})`), {
          code: 'SNAPSHOT_INCOMPLETE',
        })
      }
      return data.tree
    }
    // A truncated tree is almost always load, not size: the AX walk has an internal
    // time budget (there is no flag to raise it), and with three or four Electron
    // instances up, one window's walk can miss it while the same window snapshots
    // fine a moment later. withRetry's flat 150ms is too tight to ride that out, so
    // back off here first and only surface SNAPSHOT_INCOMPLETE once it persists.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await take()
      } catch (e) {
        if (e.code !== 'SNAPSHOT_INCOMPLETE' || attempt === 2) break
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)))
      }
    }
    try {
      return await take()
    } catch (e) {
      // agent-desktop reassigns a window's AX id when the renderer repaints/
      // reloads, so a cached windowId can go stale mid-scenario even though the OS
      // window is still there under the same pid. It surfaces two ways: the old id
      // is gone (WINDOW_NOT_FOUND), or it still resolves to a husk that answers no
      // AX query (ACTION_NOT_SUPPORTED) — which polling can never clear, because the
      // live tree now hangs off a different id. Re-resolve by pid and retry once. A
      // genuine crash (pid gone) still fails, and so does an id that is merely not
      // ready yet, which the caller's own wait rides out.
      if ((e.code !== 'WINDOW_NOT_FOUND' && e.code !== 'ACTION_NOT_SUPPORTED') || !this.pid) throw e
      const match = (await mirallWindows()).find((w) => w.pid === this.pid)
      if (!match || match.id === this.windowId) throw e
      this.windowId = match.id
      return take()
    }
  }

  async _ref(sel) {
    const tree = await this.snap({ interactive: true })
    const node = findNode(tree, { ...sel, actionable: true })
    if (!node || !node.ref) {
      throw Object.assign(new Error(`${this.name}: no element ${JSON.stringify(sel)}`), {
        code: 'ELEMENT_NOT_FOUND',
      })
    }
    return node.ref
  }

  // Raise this instance's window before acting. With two instances up, the one
  // launched last is frontmost, and AX-acting on a *background* window misfires:
  // e.g. clicking "Initialize Space" there closes the create modal instead of
  // advancing it, so "Space Created" is never seen. A real user always acts on
  // the focused window — focus first so click/type land where intended. (press()
  // already does this.)
  click(sel) {
    return withRetry(async () => {
      await this.focus()
      const ref = await this._ref(sel)
      try {
        return await this.ad(['click', ref])
      } catch (e) {
        // agent-desktop 0.8.x separates semantic delivery (AXPress) from physical
        // delivery (a real cursor click) and will not cross that line by itself:
        // an element exposing no usable press action returns POLICY_DENIED instead
        // of quietly falling back, which is what 0.4.x's activation chain did. A
        // few of our controls only have the physical path (react-aria composites
        // whose press handler sits on a wrapper node). Opt into it for exactly
        // those, rather than running the whole suite --headed — the default stays
        // cursor-free, and only the elements that need the pointer take it.
        if (e.code !== 'POLICY_DENIED') throw e
        return await this.ad(['click', ref], { headed: true })
      }
    })
  }

  // Move the OS cursor onto an element (real mouseenter/mouseleave to the DOM).
  hover(sel) {
    return withRetry(async () => {
      await this.focus()
      return this.ad(['hover', await this._ref(sel)], { headed: true })
    })
  }

  // Park the cursor in the top-left corner — guaranteed off any element, so the
  // previously-hovered node receives mouseleave.
  moveCursorAway() {
    return this.ad(['mouse-move', '--xy', '5,5'], { allowError: true, headed: true })
  }

  // agent-desktop `type` double-emits keystrokes on these React inputs; `set-value`
  // sets the value once and still fires React's onChange (verified). It returns a
  // spurious ACTION_FAILED even on success, so allow the error and verify by read-back.
  type(sel, text) {
    return withRetry(async () => {
      await this.focus()
      const ref = await this._ref(sel)
      await this.ad(['set-value', ref, text], { allowError: true })
      const got = (await this.ad(['get', ref, '--property', 'value'])).data.value
      if (got !== text) {
        throw Object.assign(new Error(`${this.name}: set-value mismatch (got ${JSON.stringify(got)})`), { code: 'STALE_REF' })
      }
      return ref
    })
  }

  // Set a field's value directly WITHOUT asserting the read-back equals it — for
  // inputs that normalise their value on change (e.g. the Join dialog stripping a
  // pasted mirall://join deep link down to the bare invite code). Still fires
  // React's onChange like type(), so the controlled value re-renders.
  async setRaw(sel, text) {
    await this.focus()
    const ref = await this._ref(sel)
    await this.ad(['set-value', ref, text], { allowError: true })
    return ref
  }

  // Raise this window only if it isn't already frontmost. Re-focusing a window
  // that's already focused is not a no-op for the UI: it dismisses an open
  // react-aria popover/menu, so an unconditional focus before every click would
  // break "open More menu → click an item" flows. Skipping when already focused
  // keeps single-instance flows untouched and only switches windows when a
  // different instance currently holds focus (the multi-instance case this guards).
  async focus() {
    // A single-instance scenario has no competing Mirall window, so this instance
    // stays frontmost after its initial raise (done unconditionally in launch()).
    // Skip the per-action list-windows round-trip (~0.4s each) AND the re-focus,
    // which would dismiss any open react-aria popover. Multi-instance still needs
    // the check to bring the acting window forward when a sibling holds focus.
    if (this.total === 1) return
    const me = (await ad(['list-windows'])).data.find((w) => w.id === this.windowId)
    if (me?.is_focused) return
    await ad(['focus-window', '--window-id', this.windowId], { allowError: true })
  }

  async press(combo) {
    await this.focus()
    return ad(['press', combo])
  }

  // Case-insensitive: macOS AX reflects CSS text-transform, so uppercased badges
  // ("MIRRORED", "SHARED BY YOU") come through transformed.
  async waitText(substr, timeout = 30000) {
    // NO native `wait --text` fast path. It used to be worth it for the
    // single-window case (~0.13s vs a ~0.4s snapshot), but agent-desktop 0.8.x
    // matches --text against an element's accessible NAME only, while the strings
    // this suite asserts on are mostly static text — and macOS AX puts static-text
    // content in `value`, not `name` (see tree.mjs). So the fast path silently
    // stopped seeing headings and body copy: `wait --text "Settings"` still matched
    // the nav BUTTON, while `wait --text "Manage your experience"` timed out on a
    // Settings screen that demonstrably contained it. The snapshot loop below reads
    // name + description + value via allText(), which is the behaviour every
    // assertion here was written against, and it is what the multi-instance path
    // already used — which is exactly why only single-instance scenarios broke.
    const needle = substr.toLowerCase()
    const deadline = Date.now() + timeout
    let last = ''
    let transient = null
    while (Date.now() < deadline) {
      // A transient AX condition is "not yet", not a failure: Chromium re-attaches the
      // tree after a repaint, and a screen change is exactly when a wait starts. Polling
      // through it is what every other caller gets from withRetry; without it a wait
      // placed right after a navigation throws instead of waiting.
      try {
        last = allText(await this.snap())
        transient = null
      } catch (e) {
        if (!RETRYABLE.has(e.code)) throw e
        transient = e
        await new Promise((r) => setTimeout(r, POLL_MS))
        continue
      }
      if (last.toLowerCase().includes(needle)) return true
      await new Promise((r) => setTimeout(r, POLL_MS))
    }
    if (transient) {
      throw new Error(
        `${this.name}: text "${substr}" not seen in ${timeout}ms (window ${this.windowId}); AX stayed unavailable: ${transient.message}`,
      )
    }
    throw new Error(
      `${this.name}: text "${substr}" not seen in ${timeout}ms (window ${this.windowId}); shows: ${last.replace(/\s+/g, ' ').slice(0, 280)}`,
    )
  }

  async hasText(substr) {
    return allText(await this.snap()).toLowerCase().includes(substr.toLowerCase())
  }

  async isChecked(sel) {
    const ref = await this._ref(sel)
    const res = await this.ad(['is', ref, '--property', 'checked'], { allowError: true })
    return res.data?.value === true
  }

  // Read a node's AX value (e.g. "0"/"1" for aria-pressed / aria-checked toggles).
  // Reads a CONTROL's value — a toggle's pressed state ("0"/"1"), a field's text —
  // so it takes the same `actionable` lens as _ref(): a <label for> surfaces as a
  // ref'd statictext with the control's accessible name and its own text as `value`,
  // and being earlier in document order it would otherwise win every name-only match
  // and return the label string instead of the control's value. Visible-text
  // assertions go through hasText()/waitText(), which deliberately still see it.
  async nodeValue(sel) {
    const node = findNode(await this.snap(), { ...sel, actionable: true })
    return node ? node.value : null
  }

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
  async isDisabled(sel) {
    const node = findNode(await this.snap(), { ...sel, actionable: true })
    return !!node && (node.states ?? []).includes('disabled')
  }

  async has(sel) {
    return !!findNode(await this.snap(), sel)
  }

  // Create a space without a peer (the create half of connectInSpace), leaving
  // the instance in the new space's view. For single-peer scenarios.
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

  // Drive a native NSOpenPanel (file or folder) belonging to THIS instance via
  // Go-to-folder. The panel surfaces as a window titled "Open" with our pid.
  //
  // `trigger` is the action that asks the app for the panel (a menu accelerator
  // press, or a "Browse…" click) and it is fired HERE rather than by the caller,
  // because it can be swallowed and then has to be re-fired. A ⌘U / ⌘⇧U goes to
  // whichever process is frontmost at that instant, so a sibling instance still
  // finishing its launch or teardown can eat it, and the File-menu items behind
  // those accelerators are `enabled: inSpace` — disabled, and therefore silently
  // inert, until the renderer's menu:context-changed IPC has landed. Either way
  // the panel never opens and no amount of extra waiting produces one: measured
  // on an idle machine, a panel that is coming takes ~1.6s, and 12/12 tries hit
  // it, so a multi-second wait that comes back empty means the trigger was LOST,
  // not late. Re-fire it instead of stretching the deadline (testing.md §5) —
  // re-firing is safe precisely because it only happens while NO panel is up.
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

  // Open a share's FolderView from the space view (the card's "Open <name>"
  // button). FolderView lists files as a flat, recursive set of relPaths, so a
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

  async clipboard() {
    return (await ad(['clipboard-get'])).data.text
  }

  // Click a copy button and return the freshly-copied text. Guards against a
  // stale clipboard (a renderer clipboard write that never lands) by seeding a
  // sentinel first and waiting for it to change.
  async copyFrom(buttonSel, timeout = 5000) {
    const sentinel = `__sentinel_${Date.now()}__`
    await ad(['clipboard-set', sentinel])
    await this.focus()
    await this.click(buttonSel)
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const v = await this.clipboard()
      if (v && v !== sentinel) return v
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error(`${this.name}: clipboard did not update after copy`)
  }

  async shot(label, dir) {
    const file = path.join(dir, `${this.name}-${label}.png`)
    await ad(['screenshot', file, '--window-id', this.windowId])
    return file
  }

  // Reap the whole detached process group and WAIT for it to actually exit.
  // Graceful (default): SIGTERM lets Electron's before-quit tear the worker swarm
  // down cleanly (~3-5s); if the group is still alive after the grace window — a
  // wedged renderer or a worker stuck on a busy loop — escalate to SIGKILL. Fire-
  // and-forget SIGTERM (the old behaviour) let the next scenario launch while two
  // Electron apps + workers were still shutting down, and over a full run those
  // overlapping teardowns piled up until a fresh worker's IPC no longer came up in
  // time (the "IPC timeout" failures). `hard:true` SIGKILLs immediately — a
  // crash / force-quit that interrupts an in-flight publish/transfer with no
  // graceful shutdown, which is exactly what the restart-recovery scenarios need.
  async _stopProcess({ hard = false } = {}) {
    const proc = this.proc
    this.proc = null
    if (!proc?.pid) return
    const exited = new Promise((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) return resolve()
      proc.once('exit', resolve)
      proc.once('error', resolve)
    })
    if (hard) {
      try { process.kill(-proc.pid, 'SIGKILL') } catch {}
      await exited
      return
    }
    try { process.kill(-proc.pid, 'SIGTERM') } catch {}
    const sigkill = setTimeout(() => { try { process.kill(-proc.pid, 'SIGKILL') } catch {} }, 6000)
    await exited
    clearTimeout(sigkill)
  }

  async kill() {
    await this._stopProcess()
    // Only now is nothing still writing the store — safe to remove it.
    try {
      rmSync(this.store, { recursive: true, force: true })
      rmSync(this.downloadFolder, { recursive: true, force: true })
    } catch {}
  }

  // Quit this instance's process but KEEP its store + download folder, then boot a
  // fresh process on the SAME store — the returning-user path (no onboarding). This
  // is how restart-recovery scenarios (quit mid-transfer / mid-index → relaunch →
  // resume / recover) are exercised at the UI layer; plain kill() wipes the store and
  // can't. `hard:true` force-quits (SIGKILL) to interrupt an in-flight operation
  // abruptly — a crash rather than a clean shutdown; default is a graceful SIGTERM
  // (faster owner-offline detection for the peer). The agent-desktop session
  // namespace is unchanged, so cross-process refs keep resolving against the fresh
  // window's snapshots. Caller waits for the post-boot content it expects (the space
  // view loads straight into the existing membership — no Welcome screen).
  // Stop this instance's process but KEEP its store + download folder (the offline half of a
  // restart, with a caller-controlled gap). Pair with launch({ onboard:false }) to bring it
  // back AFTER the peer has observed the outage — the offline→online edge that owner-return
  // auto-resume needs (a no-gap relaunch can come back before the peer ever saw it leave).
  async quit({ hard = false } = {}) {
    await this._stopProcess({ hard })
    this.windowId = null
    this.pid = null
  }

  async relaunch({ hard = false } = {}) {
    await this.quit({ hard })
    return this.launch({ onboard: false })
  }
}
