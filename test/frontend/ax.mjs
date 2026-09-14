import path from 'node:path'
import { ad, withRetry, RETRYABLE } from './agent.mjs'
import { findNode, allText } from './tree.mjs'
import { POLL_MS, mirallWindows } from './ax-support.mjs'

// The accessibility-tree half of Instance: everything that talks to agent-desktop and nothing that
// knows a Mirall screen. Applied as a mixin so the scenarios keep one object with one surface.
export const withAx = (Base) => class extends Base {
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
      // agent-desktop reassigns a window's AX id when the renderer repaints or reloads: the old id is
      // gone (WINDOW_NOT_FOUND) or resolves to a husk that answers no AX query (ACTION_NOT_SUPPORTED),
      // which polling can never clear. Re-resolve by pid and retry once; a real crash still fails.
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
        // Semantic delivery (AXPress) and physical delivery (a cursor click) are separate policies: an
        // element with no usable press action returns POLICY_DENIED rather than falling back. Opt into
        // --headed for exactly those elements (react-aria composites whose press handler sits on a
        // wrapper), so the default run stays cursor-free.
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
    // No native `wait --text` fast path: it matches an element's accessible NAME only, and static
    // text lives in `value` on macOS AX (tree.mjs), so headings and body copy are invisible to it.
    // The snapshot loop reads name + description + value via allText().
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

  async isDisabled(sel) {
    const node = findNode(await this.snap(), { ...sel, actionable: true })
    return !!node && (node.states ?? []).includes('disabled')
  }

  async has(sel) {
    return !!findNode(await this.snap(), sel)
  }

  // Create a space without a peer (the create half of connectInSpace), leaving
  // the instance in the new space's view. For single-peer scenarios.

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

  // Reap the whole detached process group and WAIT for it to exit: SIGTERM lets before-quit tear the
  // swarm down (~3-5 s), then SIGKILL if the group is still alive. Overlapping teardowns from a
  // fire-and-forget stop starve the next scenario's worker IPC. `hard:true` SIGKILLs immediately —
  // the crash the restart-recovery scenarios need.
}
