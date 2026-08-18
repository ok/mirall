# agent-desktop tests

UI smoke tests for the running Mirall window driven via the [`agent-desktop`](https://github.com/lahfir/agent-desktop) CLI. The CLI exposes the macOS Accessibility tree as JSON and lets a script observe and act on real UI elements (snapshot → find by ref → click / type / read).

## Why this exists

`tsc --noEmit` and the brittle worker tests don't exercise the renderer end-to-end. These tests catch regressions that are invisible to type-checking and unit tests:

- Buttons that lose their accessible labels (icon ligatures leaking into AX names, missing `aria-label` on icon-only buttons).
- Clickable rows that revert to `<div onClick>` and stop being reachable as buttons in the AX tree.
- Navigation flows that stop wiring screen transitions correctly.

A passing run proves: the renderer mounted, the React tree exposes its key controls with usable accessible names, and the primary navigation actually navigates.

## Scope

In scope:

- Single-instance UI plumbing on macOS (the only platform the CLI supports).
- The SharedSpaces sidebar surface (Send Feedback, Settings, All Spaces, Favorites, Create Space, Join Space).
- Opening a space card and confirming the screen transition.

Not in scope:

- P2P transfer flows (would need a second Mirall instance — separate harness).
- Windows / Linux. `agent-desktop` is macOS-only and the non-macOS release assets do not change that: the `agent-desktop-ffi-*` artifacts are the C-ABI library, the CLI ships for Darwin only, and upstream's `crates/windows` / `crates/linux` are empty scaffolds whose adapters return `PlatformNotSupported`. Upstream's own README lists every Windows/Linux capability as *Planned*.
- Worker / Bare-runtime logic (use the brittle suite under `test/index.test.js`).

## Preconditions

1. **macOS** with the `agent-desktop` CLI on `PATH` (>= 0.8.0). Install once:
   ```bash
   npm install -g agent-desktop
   ```
   Upgrading from a pre-0.5 CLI? Delete the two root state files first — older
   versions wrote refmap entries without a `process_instance`, and 0.8.x rejects
   them, so every `status` call fails with `INVALID_ARGS` until they are gone:
   ```bash
   rm -f ~/.agent-desktop/last_refmap.json ~/.agent-desktop/latest_snapshot_id
   ```
2. **Accessibility permission** granted to whichever process runs the CLI (your terminal, or the Claude Code harness). Verify with:
   ```bash
   agent-desktop status
   ```
   If `permissions.granted` is `false`, open *System Settings → Privacy & Security → Accessibility* and add the terminal app, or run `agent-desktop permissions --request` to trigger the system dialog.
3. **`jq`** on `PATH` (preinstalled on macOS).
4. **Mirall is running** in one of two modes:
   - Installed app — process name `Mirall`. This is what end users see.
   - Dev build via `npm start` / `electron-forge start` — process name `Electron`.
5. **Only one Electron window open.** If Chrome DevTools is attached, close it first (Cmd+Opt+I in Mirall, or Cmd+W from inside DevTools). Both windows are owned by the same `Electron` app, and this script targets by `--app`. On 0.8.x that is a hard `AMBIGUOUS_TARGET` error listing the candidates — earlier versions silently snapshotted whichever window had focus, which was usually DevTools and produced a confusing "button not found" instead.

## How to run

```bash
test/agent-desktop/smoke-test.sh           # against installed Mirall
test/agent-desktop/smoke-test.sh Electron  # against the dev build
```

The script exits 0 on full pass, non-zero on first failure with a `FAIL: ...` line and the offending JSON error printed to stderr.

Expected output on success (12 lines, all `PASS:`):

```
PASS: Accessibility permission granted
PASS: Window for 'Electron' reached (14 refs)
PASS: sidebar: Send Feedback
PASS: sidebar: All Spaces
PASS: sidebar: Favorites
PASS: sidebar: Create Space
PASS: sidebar: Join Space
PASS: space card found: Open <space-name> (@s359l44w95ysun:e8)
PASS: clicked @s359l44w95ysun:e8
PASS: left SharedSpaces screen
PASS: on space screen (Files Shared)

All smoke checks passed against 'Electron'.
```

Side effect: the script clicks into the first space card it finds and leaves the app on that space's view. Rerunning may pick a different space card depending on order. Navigate back manually before rerunning if you want a deterministic starting state.

## Common failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `APP_NOT_FOUND: No window found for app 'Mirall'` | Wrong process name. Dev build runs as `Electron`. | Pass the right argument: `smoke-test.sh Electron`. |
| Snapshot returns DevTools UI (`Send Feedback` not found, ref_count ~8, "Developer Tools" in tree) | Chrome DevTools window is open under the same `Electron` process. | Close DevTools and rerun. |
| `permissions.granted: false` | Terminal lost Accessibility permission (common after macOS updates or terminal upgrades). | Re-grant in System Settings → Privacy & Security → Accessibility. |
| `AMBIGUOUS_TARGET: More than one window matches the target` | More than one `Electron` window (usually DevTools, sometimes a second dev instance). The error's `details.candidates` lists them. | Close the extra window, or re-run the failing command with `--window-id <id>` from `list-windows`. |
| `INVALID_ARGS: RefEntry requires a positive pid and process instance` | Left-over `~/.agent-desktop` state written by a pre-0.5 CLI. | `rm -f ~/.agent-desktop/last_refmap.json ~/.agent-desktop/latest_snapshot_id` |
| `ACTION_FAILED: All chain steps exhausted` on click | Transient focus state, modal overlay, or the target stopped being interactable since the snapshot. | Rerun. If reproducible, fall back to `agent-desktop mouse-click --xy X,Y` after `agent-desktop get @ref bounds`. |
| `STALE_REF: Element not found: role=..., name="..."` | A ref from an earlier snapshot no longer matches because the UI changed (e.g. a button's accessible name changed after a fix). | Re-run `snapshot` and use the new ref. |

## Working interactively (without the script)

The same primitives the script uses, by hand:

```bash
agent-desktop status
agent-desktop snapshot --skeleton --app "Electron" -i --compact
agent-desktop find --app "Electron" --role button --name "Create Space"
agent-desktop click @e6
agent-desktop snapshot --root @e3 --app "Electron" -i --compact   # drill into a subtree
agent-desktop screenshot --app "Electron"
```

Refs are scoped to a single `snapshot` invocation and assigned in depth-first interactive order. Re-snapshot after any UI change before reusing a ref. Since 0.8.0 a ref is **snapshot-qualified** — `@s359l44w95ysun:e3`, not `@e3` — so it carries its own scope and resolves in a later CLI process on its own. A bare `@e3` still works, but only with an explicit `--snapshot <id>` (or a `--session` whose latest snapshot is the one you meant).

aria-label on icon-only buttons and on `<div role="button">` lands in the AX `description` field, not `name`. Use both when matching:

```bash
jq -r '.. | objects | select(.role=="button") | (.name // "") + "|" + (.description // "")'
```

## Extending the suite

When adding new flows, keep them as separate `*.sh` files in this directory so each can run in isolation. The current script is intentionally one file — split it once a second flow exists.

Useful conventions, copied from `smoke-test.sh`:

- `set -euo pipefail` so first failure aborts.
- An `expect_ok` wrapper that runs `agent-desktop <cmd>`, asserts `ok: true` on the JSON, prints the error and exits otherwise.
- Match labels against `(name // "") + "|" + (description // "")` — both fields can carry the accessible name depending on element type.
- Match against both English and German strings for screen-content assertions, since the locale follows the user's system or saved preference.
- After every action, re-snapshot before the next assertion. Refs do not persist across UI changes.

## File layout

```
test/agent-desktop/
├── README.md          this file
└── smoke-test.sh      sidebar + open-a-space flow
```

## References

- CLI source / issues: https://github.com/lahfir/agent-desktop
- CLI help: `agent-desktop help` (top-level) and `agent-desktop help <command>` (per-subcommand flags).
- Skill wrapper for use inside Claude Code: `~/.claude/skills/agent-desktop/SKILL.md`.
