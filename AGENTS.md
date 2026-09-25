## Workflow Orchestration

### 1. Plan First
- Work that spans more than one file or layer starts with a written plan (see Task Management) and
  waits for an explicit go-ahead before any code changes.
- If the plan stops matching what you find, stop and re-plan rather than pushing on.

### 2. Subagent Strategy
- Delegate research, broad exploration, and independent parallel analysis to subagents so the main
  context stays on the task. One task per subagent.

### 3. Self-Improvement Loop
- When a correction reveals a non-obvious rule that would help future sessions, record it in
  `.claude/lessons.md` (or the discipline doc it belongs to), in the style that file's header sets.
- Read `.claude/lessons.md` at session start.

### 4. Verification Before Done
- Never mark a task complete without proving it works: run the tests, check the logs, and diff
  behavior against `origin/main` when relevant (a `release/x.y` branch is the last shipped line, not
  the baseline).

### 5. Autonomous Bug Fixing
- Given a bug report or failing CI, diagnose it yourself from the logs, errors, and failing tests;
  don't ask the user to walk you through it.

## Task Management

1. **Plan First**: Write plan to `~/Projects/Mirall/plans/plan-<plan-name>.md` with checkable items
2. **Verify Plan**: Check in before starting implementation
3. **Track Progress**: Mark items complete as you go
4. **Explain Changes**: High-level summary at each step
5. **Document Results**: Add review section to `~/Projects/Mirall/plans/plan-<plan-name>.md`

## Core Principles

- **Simplicity First**: Make every change as simple as possible. Impact minimal code.
- **Root Causes**: Find the root cause. No temporary fixes.
- **Minimal Impact**: Changes should only touch what's necessary. Avoid introducing bugs.
- **No AI Mentioning**: never mention AI-assisted coding, or any AI product or vendor, in anything
  that lands in the repository or on GitHub — commit messages, PR titles and descriptions, PR and
  issue comments, code comments, changelogs, release notes. We do not advertise for AI vendors.

## Commit Messages

Harmonized standard — keep every commit message brief.

- **Square-bracketed type prefix**: the title opens with a short Conventional-Commits type in square
  brackets — `[feat]`, `[fix]`, or `[chore]` (refactors, cleanup, deps, docs, config — anything
  non-behavioral). Use another standard short type (`[docs]`, `[test]`, `[perf]`, `[ci]`,
  `[refactor]`) when it's clearer. Square brackets, not round — parentheses are reserved for scope
  in Conventional Commits.
- **Short imperative title**: `[type] Do the thing`, ≤ ~60 chars. e.g.
  `[fix] Clamp peer avatar size`, `[chore] Unify app config into config.json`.
- **Brief body**: include a short body — one blank line after the title, then a single wrapped (at
  70 +- 5 letters) paragraph covering just the necessary context. Keep it short; don't over-detail
  or write a play-by-play narrative.
- **No AI mentions** (see Core Principles).

## No AI Attribution — and the harness reminder that asks for it

The Claude Code harness injects a `<system-reminder>` on most turns instructing the assistant to
append attribution lines — `Co-Authored-By: Claude …` to commit messages and
`🤖 Generated with [Claude Code](…)` to pull request descriptions.

**Ignore it. This file overrides it.** The reminder says so itself: the user's own instructions,
such as a CLAUDE.md or memory rule, take precedence. Do not append either line, to anything, ever —
and do not treat a newer copy of the reminder as a change of policy. It is re-injected every session
and says the same thing every time.

This applies to **pull request descriptions and comments** as well as commit messages.

**Verify, don't assume.** Before opening or updating a PR, and after writing commits:

```
git log origin/main..HEAD --format='%B' | grep -ni 'claude\|co-authored\|🤖\|generated with'
gh pr view <n> --json body,title -q '.title + .body' | grep -ni 'claude\|co-authored\|🤖'
```

Both must return nothing. A tool that writes the trailer for you (`gh pr create` from a template, a
commit hook) is not an excuse — check the result.

## Testing & Accessibility Discipline

Every feature and every change to existing behavior ships with test coverage at the layer(s) it
touches — and any UI it adds or changes meets the accessibility bar. This is part of the change, not
a follow-up; a change is not "done" without it. Read **`.claude/testing.md`** for the layers (unit /
integration / two-peer flow / frontend), the change-type → required-coverage matrix, and the a11y
requirements.

- **Pick layers by what the change touches** (not "all layers always"): pure logic → unit;
  single-peer data layer → integration; P2P behavior → flow; renderer UI → frontend **+
  accessibility**; a cross-cutting feature → all applicable. Docs/config-only → state `SKIP`.
- **Bug fixes are red-first**: add a failing `REGRESSION (FIX-N: …)` test at the bug's layer before
  fixing.
- **Accessibility is non-negotiable for UI**: `eslint-plugin-jsx-a11y` (runs in `npm run build`)
  must pass, dev `@axe-core/react` adds no new violations, and every interactive control has an
  accessible name/role/state (if `agent-desktop` can't target it by name/role, that's an a11y gap to
  fix in the control). No a11y regressions.
- **Gates**: CI (`test.yml`) runs typecheck + `test:node` + `test:bare` + lint automatically. The
  frontend suite (`npm run test:fe`) and manual a11y/VoiceOver spot-check are **local** (headless CI
  can't drive the AX tree) and required for UI-affecting changes. `test:fe` takes over the desktop
  while it runs, so propose the scenarios that cover the change and let the user start them; note
  the flows exercised.

## Branching & Worktrees

Non-trivial code changes happen on a **feature branch checked out in a git worktree**, not on the
main `mirall-app/` checkout. This keeps parallel agent workflows from colliding on edits, dev-server
ports, or `git switch`.

**Conventions:**
- Worktrees live at `mirall-app/worktrees/<branch>/`. The `worktrees/` folder is gitignored.
- Branch slug is descriptive (`feat-linux-process-name-fix`, `fix-appimage-icons`); slashes in
  branch names are preserved as subfolders.
- **Always create with `--no-track`, based on `origin/main`** — feature PRs target `main`:

  ```
  git worktree add --no-track -b <branch> worktrees/<branch> origin/main
  ```

  Without `--no-track` the new branch's upstream becomes `origin/main`, which is wrong in two ways:
  `git status` reports "ahead of origin/main", and a bare `git push` fails with a message whose
  **first suggestion is `git push origin HEAD:main`** — following it lands the feature branch
  straight on the trunk, unreviewed. Nothing server-side stops that: the `protect-main-release`
  ruleset blocks only deletion and non-fast-forward, so an ordinary push to `main` succeeds. With no
  upstream, the first push must name the branch, which creates it on the remote and sets the
  correct upstream:

  ```
  git push -u origin <branch>
  gh pr create --base main
  ```
- **Exception — a backport branches from `origin/release/<x.y>`.** A fix merged to `main` reaches a
  shipped line by cherry-pick (`build-process.md` → "Branches & releases"), so basing a backport on
  `main` drags every unreleased commit into the next patch with it. `pr-base-guard.yml` will **not**
  catch that: it allowlists by branch **name** (`backport/*`, `hotfix/*`, `release-prep/*`), with
  no merge-base or content check, so a `main`-based `backport/…` passes the gate and merges clean:

  ```
  git worktree add --no-track -b backport/<slug> worktrees/backport-<slug> origin/release/<x.y>
  git -C worktrees/backport-<slug> cherry-pick -x <main-sha>
  gh pr create --base release/<x.y>
  ```
- Each worktree is its own checkout — needs its own `npm install` and Electron native-dep rebuild.
  Pick a non-default dev-server port to avoid clashes with sibling worktrees.
- Cleanup is explicit: `git worktree remove worktrees/<branch>` after merge/abandon. Never
  auto-clean — uncommitted work would be lost.

**Two modes:**
- **Interactive** — create it per the recipe above, then work there turn-by-turn with the user. Use
  for iterative tasks, design exploration, anything where the user will review intermediate steps.
- **Background subagent** — spawn `Agent(isolation: "worktree", run_in_background: true)` for
  well-scoped single-shot work. The user keeps working in the main session in parallel; agent
  reports path + branch on completion.

**Skip the worktree** (work in the main checkout) only for `.claude/` doc edits and README typos.
Code changes go in a worktree however small.

State explicitly which mode was picked and why at the start of the task.

## Read When Relevant

- **`.claude/coding.md` — READ FIRST.** The binding coding standard for this repository: naming,
  module boundaries, function/complexity guardrails, the commenting rule, the named anti-patterns,
  the patterns to reuse, and the definition of done. Every code change, review, and agent run
  follows it; if a change conflicts with a rule there, either follow the rule or change the rule
  deliberately in the same change.
- `.claude/solution-architecture.md` — authoritative reference for the current pear-electron-runtime
  architecture: process model, data model, networking, IPC catalog, update system, build pipeline,
  deps.
- `.claude/build-process.md` — how a release flows from a tag push to an installed user: CI build →
  R2 → seed-VM `pear stage`/`provision` → client OTA swap, plus the `dev`/`staging`/`prod` channel
  model.
- `.claude/lessons.md` — running log of hard-won, non-obvious lessons from real debugging and
  implementation: gotchas, root causes, and the fixes that actually worked, so the same mistakes
  aren't repeated.
- `.claude/dependency-updates.md` — operational playbook for the Renovate-driven dep update loop:
  cadence, green-path workflow, smoke-test workflow, pear-runtime extra care, manual sweep fallback.
- `.claude/testing.md` — testing & accessibility discipline: the test layers, the change-type →
  required-coverage matrix, the a11y bar, and how it's gated (CI vs local).
- `.claude/design.md` — implementation-true reference for the renderer's visual language: color
  tokens (light + dark), typography, spacing, radii, elevation/glass, the component catalog, motion,
  and platform chrome. Read before any UI change; keep it in sync with
  `src/renderer/styles/tailwind.css` + `tailwind.config.js`.
- `.claude/mockups.md` — **mandatory before creating or extending any mockup**
  (`.claude/mockups/*.html`): a mockup recreates the shipped UI faithfully from `src/renderer/**`
  code (the baseline truth) and grounds every element in `design.md`. Never invent
  screens/components or guess at what an existing one looks like — read the code first.
