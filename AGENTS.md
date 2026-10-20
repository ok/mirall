# Mirall

Sibling repos: `mirall-console` (the admin console: it produces the managed-configuration and
upward contracts), `mirall-publisher` (the config drive), `mirall-cloudflare` (the API gateway),
`mirall-relay`. Some are private: a contributor without access works from the contract copies in
this repo (*Evidence*), which is enough to build and test against.

Plans live outside git, in the plans folder. This file holds no build, release or deployment
status: that is a fact about the code and the releases, and it lives there.

**Local paths are per contributor.** Where your sibling checkouts and the plans folder are lives in
`AGENTS.local.md` at the repo root (gitignored; `CLAUDE.md` imports it beside this file). This file
names repos and repo-relative paths only. If `AGENTS.local.md` is missing or lacks a path you need,
ask for it once and write it there.

## Evidence: where facts live, and how a claim is proven

This app consumes contracts other repos produce, and every feature is described by plans that age.
A claim about what exists is only as good as the place it was read from, so every agent reads from
the same places and shows where.

### Each kind of fact has one home

| Fact | Its home | Never evidence for it |
|---|---|---|
| What the app does | code and tests at `origin/main`, after `git fetch` (a `release/x.y` branch is the last shipped line, not the baseline) | plans, status lines, memory, this file |
| What a contract is | the byte copies in `test/fixtures/managed/`, at the producer commit `SOURCES.md` names | plan prose that restates them, the producer's source read by hand |
| What a producer has published since | the producer repo at a tag or commit, for those with access | another agent's or a relayed summary |
| Why it is that way | the tests that guard it, and the reasoning in `.claude/solution-architecture.md`, `coding.md`, `build-process.md` | — |
| What we intend to build | one plan per feature | — |

Plans, memory and snapshots are **leads**: they tell you where to look, never what is true.

### Rules

1. **Fetch first.** At session start, and before any claim about another repo, run `git fetch` here
   and in each sibling you will cite. Read a sibling with `git -C <sibling> show origin/main:<path>`
   or `git -C <sibling> grep <pattern> origin/main`, not its working tree, which may be on any
   branch.
2. **A claim about state cites its evidence**: `repo:path:line @ sha`, where `sha` is the
   `origin/main` commit it was read at (`mirall-app:src/shared/audit/audit-log.js:74 @ 68f6dc14`). A
   claim that something landed cites the commit or PR (`#711`). This holds in chat, plans, PR bodies
   and hand-backs alike.
3. **"Not built" needs the search, not the silence.** A negative claim states what was searched and
   at which commit: `git grep -n "audit-ingest" origin/main -- src/ @ 68f6dc14 → no matches`.
4. **No evidence, say so.** A claim not checked this session is marked **unverified**, with where it
   came from ("unverified — from the forwarding plan §2"). Never pass a plan's sentence on as a fact.
5. **A disagreement is settled by the code, not by negotiation.** When a plan, another agent or a
   relayed message states something the code or a fixture contradicts, report both with evidence and
   say which one the code supports. Don't adapt quietly in either direction. People are asked to
   make decisions, never to arbitrate facts.
6. **A contradicted plan is not repaired.** When a plan says something the code contradicts, the
   code wins and the plan is ignored on that point. Plans carry no state to keep up to date (below).
7. **The fixtures are copies, never edited.** A contract changes only when its producer publishes it;
   the app re-copies the files in a deliberate commit that names the producer commit, and updates
   `SOURCES.md`. Where the app's needs and a fixture differ, stop and report it; never adapt the
   copy or code around it.

### Plans: a feature description and its decisions, nothing else

**A plan is never a source of state or of record.** It says what someone intends to build and why.
It is outside git, so another contributor may never see it, and it ages the moment code lands.

**Its shape is fixed.** A plan, `<plans folder>/plan-<name>.md`, has exactly two parts:

1. **Feature description** — the problem, who it is for, what changes for them, what is out of
   scope. Intent only. A sentence about how things are today cites its evidence (rule 2) or is not
   written.
2. **Decisions** — one table:

   | # | Decision | Why | Rules out | Side | Status |
   |---|---|---|---|---|---|
   | F-1 | … | … | … | `App` / `Console` / `Both` | `[proposed]` / `[agreed]` |

   `[agreed]` only after it was explicitly confirmed. Facts are not decisions: a row never records
   what exists.

**What a plan never holds:** status lines, checklists, ticks, progress, a review section, line
references, or a restatement of a contract. Progress is in branches, commits and PRs; contracts are
in their fixture copies; how the work is broken into steps is worked out in plan mode at the start
of each session, from the code.

**Decisions live in a plan only while the feature is in progress.** There is no decision log: what
the app does is read from the code. But the code shows what, not why or what was ruled out, so before
the code that depends on an `[agreed]` `App` or `Both` row merges, the row goes to exactly one of:

1. **A test**, when it is an invariant ("the profile key is never sent upward", "a forwarded event
   carries no names"). The code then guards the decision itself. Preferred.
2. **A sentence or two of reasoning** in the discipline doc that owns the area —
   `solution-architecture.md` (design, and its known limitations), `coding.md` (how code is written),
   `build-process.md` (releases, channels, compatibility) — at the place a reader would look.
3. **Nothing**, when it only mattered while building (an order of work, a temporary split).

The test between 2 and 3: would someone later be tempted to undo this, and would the code alone stop
them? If not, write the why down where they will look. A promise to people outside the code (what an
organization sees, a known limitation) also reaches the user docs or the privacy policy. A decision
about a contract stays with its producer; the app keeps only the fixture copies. The reason for a
change goes in its commit message, PR body or `CHANGELOG.md` entry.

### Obsolete plans

**Every plan written before 2026-10-20 is obsolete**, and so is everything in any plans archive. They
are not read for facts, not searched, not cited, and not updated.

Starting work on a feature one of them describes means writing a **new** plan in the shape above.
The person directing the work may ask for the obsolete plan to be mined for it. Then each thing taken
over is one of two kinds, and is handled as that kind:

- **A fact** ("`truncateLog()` resets `nextSeq` to 0") is re-established from the code at
  `origin/main` with its evidence (rule 2) — or dropped. It goes into the feature description only if
  it is needed there.
- **A decision** becomes a row in the new table, `[proposed]` until it is confirmed again. If a test
  or a discipline doc already carries it, the row cites that instead and needs no new answer.

Nothing is copied over on the old plan's authority. The new plan names the obsolete one it drew on,
so the trail is visible; the obsolete one is left as it is.

### Hand-backs across repos

What one side gives the other names an immutable point: a tag, a commit or a PR, plus the files that
changed. "The app re-copied `upward-v1.json` @ `b549ef6` in #<n>" or "1.14.0 forwards activity" is a
hand-back; "the app supports forwarding now" is not.

## Workflow Orchestration

### 1. Plan First
- Two different things share the word "plan". The **plan file** (*Plans*) holds a feature's
  description and decisions, and outlives sessions. **Plan mode** works out the steps for this
  session, from the code at `origin/main`, and is thrown away.
- Work that spans more than one file or layer starts with the steps worked out in plan mode and waits
  for an explicit go-ahead before any code changes.
- A step that rests on a fact cites it (*Evidence*); a step never rests on a plan file's word.
- A question that only a person can answer becomes a `[proposed]` row in the plan file, not an
  assumption in the steps.
- If the steps stop matching what you find, stop and re-plan rather than pushing on.

### 2. Subagent Strategy
- Delegate research, broad exploration, and independent parallel analysis to subagents so the main
  context stays on the task. One task per subagent.
- A subagent's report is held to *Evidence*: brief it to fetch, read at `origin/main`, and return
  `repo:path:line @ sha` for every claim. A finding without it is a lead, re-checked before use.
- Never point a subagent at the plans folder for facts; obsolete plans only when mining was asked
  for.

### 3. Self-Improvement Loop
- When a correction reveals a non-obvious rule that would help future sessions, record it in
  `.claude/lessons.md` (or the discipline doc it belongs to), in the style that file's header sets.
  Agent memory and plan files are per contributor: a rule kept only there reaches no one else.
- Session start: fetch (*Evidence* rule 1), then read `.claude/lessons.md`.

### 4. Verification Before Done
- Never call a task done without proving it works: run the tests, check the logs, and diff behavior
  against `origin/main` when relevant (a `release/x.y` branch is the last shipped line, not the
  baseline). "Done" is said in chat or a PR, with the commit, never ticked in a plan file.
- A summary of what is done or open cites its evidence (*Evidence* rule 2). A summary that cannot is
  not a verification.

### 5. Autonomous Bug Fixing
- Given a bug report or failing CI, diagnose it yourself from the logs, errors, and failing tests;
  don't ask the user to walk you through it.
- "Diagnose it yourself" stops at the repo boundary. When the cause is in a producer repo or a
  contract fixture, report it with evidence and the proposed change; never patch the copy, never
  code around the contract (*Evidence* rule 7).

### 6. Features that span the app and a producer repo
- One plan file per feature, shared by both repos' agents. Each decision row names its side; at
  merge the app settles its `App` and `Both` rows as *Plans* says, the producer as its own rules say.
- The order is fixed: the producer publishes the contract change first (schema and vectors, additive,
  tagged); the app re-copies the files and records the commit in `SOURCES.md`; neither side builds
  against a description.
- A hand-off names a tag, commit or PR and the files (*Hand-backs across repos*). "Ready" without one
  is not a hand-off.
- A disagreement about what exists is settled by reading the code and the fixtures (*Evidence*
  rule 5), not by asking the other agent or the person relaying.

## Task Management

1. **Plan First**: Write the feature description and its decisions table (*Plans*) — a new plan,
   never an edit of an obsolete one
2. **Verify Plan**: Check in before starting implementation; every `[proposed]` row needs an answer
3. **Break it down in plan mode**: Steps come from the code at `origin/main` each session, not from
   the plan file, which holds no steps
4. **Explain Changes**: High-level summary at each step, citing commits (*Evidence*)
5. **Settle the Decisions**: before merge, each `[agreed]` row becomes a test, a sentence in its
   discipline doc, or nothing (*Plans*); the reason for each change goes in its commit message, PR
   body or changelog entry

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
  can't drive the AX tree) and required for UI-affecting changes. Background mode (the default)
  keeps the app windows behind the user's apps and never takes the keyboard or pointer, so **the
  agent runs the targeted scenarios for a change itself, without asking** (`npm run test:fe s4
  s152`) and names them. The **full suite needs the user's approval first**: `test:fe` with no
  scenario id runs all of it, and so does any flag-only call (there is no `--help`). So does
  `--foreground`, which takes the desktop.

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
  model. Its *Changelog* section is the rule for every `CHANGELOG.md` entry: what and why, never
  how, at most four lines.
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
