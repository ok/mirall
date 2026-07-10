## Workflow Orchestration

### 1. Plan Node Default
- Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions)
- If something goes sideways, STOP and re-plan immediately – don't keep pushing
- Use plan mode for verification steps, not just building
- Write detailed specs upfront to reduce ambiguity

### 2. Subagent Strategy
- Use subagents liberally to keep main context window clean
- Offload research, exploration, and parallel analysis to subagents
- For complex problems, throw more compute at it via subagents
- One task per subagent for focused execution

### 3. Self-Improvement Loop
- After ANY correction from the user: update `.claude/lessons.md` with the pattern
- Write rules for yourself that prevent the same mistake
- Ruthlessly iterate on these lessons until mistake rate drops
- Review lessons at session start for relevant project

### 4. Verification Before Done
- Never mark a task complete without proving it works
- Diff behavior between main and your changes when relevant
- Ask yourself: "Would a staff engineer approve this?"
- Run tests, check logs, demonstrate correctness

### 5. Demand Elegance (Balanced)
- For non-trivial changes: pause and ask "is there a more elegant way?"
- If a fix feels hacky: "Knowing everything I know now, implement the elegant solution"
- Skip this for simple, obvious fixes – don't over-engineer
- Challenge your own work before presenting it

### 6. Autonomous Bug Fixing
- When given a bug report: just fix it. Don't ask for hand-holding
- Point at logs, errors, failing tests – then resolve them
- Zero context switching required from the user
- Go fix failing CI tests without being told how

## Task Management

1. **Plan First**: Write plan to `~/Projects/Mirall/plans/plan-<plan-name>.md` with checkable items
2. **Verify Plan**: Check in before starting implementation
3. **Track Progress**: Mark items complete as you go
4. **Explain Changes**: High-level summary at each step
5. **Document Results**: Add review section to `~/Projects/Mirall/plans/plan-<plan-name>.md`
6. **Capture Lessons**: Update `.claude/lessons.md` after corrections

## Core Principles

- **Simplicity First**: Make every change as simple as possible. Impact minimal code.
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards.
- **Minimal Impact**: Changes should only touch what's necessary. Avoid introducing bugs.
- **No AI Mentioning**: avoid any mentionin of AI assisted coding in any commit messages.

## Commit Messages

Harmonized standard — keep every commit message brief.

- **Square-bracketed type prefix**: the title opens with a short Conventional-Commits type in square brackets — `[feat]`, `[fix]`, or `[chore]` (refactors, cleanup, deps, docs, config — anything non-behavioral). Use another standard short type (`[docs]`, `[test]`, `[perf]`, `[ci]`, `[refactor]`) when it's clearer. Square brackets, not round — parentheses are reserved for scope in Conventional Commits.
- **Short imperative title**: `[type] Do the thing`, ≤ ~60 chars. e.g. `[fix] Clamp peer avatar size`, `[chore] Unify app config into config.json`.
- **Brief body**: include a short body — one blank line after the title, then a single wrapped (at 70 +- 5 letters) paragraph covering just the necessary context. Keep it short; don't over-detail or write a play-by-play narrative.
- **No AI mentions** (see Core Principles).

## Testing & Accessibility Discipline

Every feature and every change to existing behavior ships with test coverage at the layer(s) it touches — and any UI it adds or changes meets the accessibility bar. This is part of the change, not a follow-up; a change is not "done" without it. Read **`.claude/testing.md`** for the layers (unit / integration / two-peer flow / frontend), the change-type → required-coverage matrix, and the a11y requirements.

- **Pick layers by what the change touches** (not "all layers always"): pure logic → unit; single-peer data layer → integration; P2P behavior → flow; renderer UI → frontend **+ accessibility**; a cross-cutting feature → all applicable. Docs/config-only → state `SKIP`.
- **Bug fixes are red-first**: add a failing `REGRESSION (FIX-N: …)` test at the bug's layer before fixing.
- **Accessibility is non-negotiable for UI**: `eslint-plugin-jsx-a11y` (runs in `npm run build`) must pass, dev `@axe-core/react` adds no new violations, and every interactive control has an accessible name/role/state (if `agent-desktop` can't target it by name/role, that's an a11y gap to fix in the control). No a11y regressions.
- **Gates**: CI (`test.yml`) runs typecheck + `test:node` + `test:bare` + lint automatically. The frontend suite (`npm run test:fe`) and manual a11y/VoiceOver spot-check are **local** (headless CI can't drive the AX tree) — run them for UI-affecting changes and note the flows exercised.

## Branching & Worktrees

Non-trivial code changes happen on a **feature branch checked out in a git worktree**, not on the main `mirall-app/` checkout. This keeps parallel agent workflows from colliding on edits, dev-server ports, or `git switch`.

**Conventions:**
- Worktrees live at `mirall-app/worktrees/<branch>/`. The `worktrees/` folder is gitignored.
- Branch slug is descriptive (`feat-linux-process-name-fix`, `fix-appimage-icons`); slashes in branch names are preserved as subfolders.
- Each worktree is its own checkout — needs its own `npm install` and Electron native-dep rebuild. Pick a non-default dev-server port to avoid clashes with sibling worktrees.
- Cleanup is explicit: `git worktree remove worktrees/<branch>` after merge/abandon. Never auto-clean — uncommitted work would be lost.

**Two modes:**
- **Interactive** — `git worktree add worktrees/<branch> -b <branch> main`, then work there turn-by-turn with the user. Use for iterative tasks, design exploration, anything where the user will review intermediate steps.
- **Background subagent** — spawn `Agent(isolation: "worktree", run_in_background: true)` for well-scoped single-shot work. The user keeps working in the main session in parallel; agent reports path + branch on completion.

**Skip the worktree** (work in the main checkout) for: one-line typo fixes, README/comment tweaks, `.claude/` doc edits, anything trivial enough that worktree overhead isn't worth it.

State explicitly which mode was picked and why at the start of the task.

## Architecture Snapshot

Mirall is a peer-to-peer file-sharing desktop app. Three-process architecture, all source under `src/`:

- **Electron main** (`src/main/main.js`) — host process. Embeds `pear-runtime` as a library, owns the BrowserWindow, the OTA updater (provided by the embedded `pear-runtime`, which carries `pear-runtime-updater` transitively), the owned-folder filesystem watcher (`chokidar`, since Bare has no recursive watch), and the IPC bridge that relays frames between renderer and worker in both directions. Spawns the worker via `pear.run('/src/worker/main.js')`.
- **Electron renderer** (`src/renderer/` → `assets/dist/`) — sandboxed React 19 + Tailwind v4 UI, bundled by esbuild. Reaches main via `window.bridge` (contextBridge in `src/preload/preload.js`).
- **Bare worker** (`src/worker/main.js`; data layer in `src/shared/*`) — spawned by `pear.run()`. Hosts all P2P data-layer logic: Corestore, Hyperbee, Hyperdrive, Hyperswarm, Protomux handshake (`mirall/handshake`), transfers, owned/foreign folder sync. Talks to the renderer through main over a Bare IPC pipe (NDJSON request/response + events). `src/shared/*` is the worker's data layer — the renderer imports nothing from it.

Distribution: `.dmg` (macOS, signed + notarized) and `.msix` (Windows, signed locally via Certum) built by `electron-forge` makers; `.AppImage` (Linux, unsigned by convention) assembled by `scripts/build-app-image.sh` from forge's packaged output. CI builds every platform target in `.github/workflows/build-electron.yml`. OTA updates flow through a per-channel Pear Hyperdrive (channels `dev` / `staging` / `prod`) seeded by an Arch Linux VM running `mirall-seed.service` (`pear seed production`); 

## Obligatory Reading

- `.claude/solution-architecture.md` — authoritative reference for the current pear-electron-runtime architecture: process model, data model, networking, IPC catalog, update system, build pipeline, deps.
- `.claude/build-process.md` — how a release flows from a tag push to an installed user: CI build → R2 → seed-VM `pear stage`/`provision` → client OTA swap, plus the `dev`/`staging`/`prod` channel model.
- `.claude/lessons.md` — running log of hard-won, non-obvious lessons from real debugging and implementation: gotchas, root causes, and the fixes that actually worked, so the same mistakes aren't repeated.
- `.claude/dependency-updates.md` — operational playbook for the Renovate-driven dep update loop: cadence, green-path workflow, smoke-test workflow, pear-runtime extra care, manual sweep fallback.
- `.claude/testing.md` — testing & accessibility discipline: the test layers, the change-type → required-coverage matrix, the a11y bar, and how it's gated (CI vs local).
- `.claude/design.md` — implementation-true reference for the renderer's visual language: color tokens (light + dark), typography, spacing, radii, elevation/glass, the component catalog, motion, and platform chrome. Read before any UI change; keep it in sync with `src/renderer/styles/tailwind.css` + `tailwind.config.js`.
- `.claude/mockups.md` — **mandatory before creating or extending any mockup** (`.claude/mockups/*.html`): a mockup recreates the shipped UI faithfully from `src/renderer/**` code (the baseline truth) and grounds every element in `design.md`. Never invent screens/components or guess at what an existing one looks like — read the code first.
