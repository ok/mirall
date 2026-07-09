# Mockup Discipline

Authoritative rules for creating UI mockups (the `.claude/mockups/*.html` files). A
mockup is a **proposal rendered in the app's real visual language** — never an invented
aesthetic, and never a guess at what an existing screen looks like.

---

## The non-negotiable principle

**A mockup depicts reality plus the proposed delta.** When a mockup extends or modifies
an existing screen, modal, or component, the existing parts **must be recreated
faithfully from the shipped code**, and the new/changed parts **must be built from
existing primitives and the documented design tokens.**

Two grounding truths, both mandatory:

1. **The implemented code is the baseline.** What ships in `src/renderer/**` is the
   source of truth for any screen/modal/component a mockup touches. **Read the actual
   file(s)** and reproduce structure, class names, component props, real copy, and a11y
   attributes — do **not** approximate from memory or invent layout. The truth is always
   what is implemented in code.
2. **`design.md` is the grounding truth for the visual language.** Colors, typography,
   spacing, radii, elevation, the component catalog, motion, platform chrome. Every
   element of a mockup resolves to a documented token/component. No raw hex (except the
   curated space-icon palette), no invented type scale, no new glass surfaces, no 1px
   layout borders.

If you cannot name the file (for recreated parts) or the `design.md` token/component
(for new parts) a mockup element is based on, it does not belong in the mockup.

---

## Procedure (every time, before writing any HTML)

1. **Identify the surfaces touched.** List the exact screens/modals/components the
   mockup extends.
2. **Read them in code first.** Open the real `.tsx` files. Copy the structure: header
   anatomy, body sections, the actual class strings, `role`/`aria-*`, props, defaults.
   Read the locale JSON (`src/renderer/locales/en/common.json`) for the **real**
   user-facing strings and use them verbatim — don't paraphrase.
3. **Reuse primitives.** `Button` (primary/secondary/danger), `Toggle`, `Modal`,
   `Avatar`, `IconButton`, `Badge`, toast, etc. live in
   `src/renderer/components/` (the segmented control is an inline pattern, not a primitive). A mockup control is one of these unless the proposal is
   explicitly a new primitive (rare — justify it).
4. **Build the delta in the same language.** New/changed UI uses the same tokens, radii,
   spacing, focus rings, and a11y patterns as the surrounding real UI.
5. **Annotate.** Mark which parts are recreated-from-code vs proposed; caption the a11y
   intent; show rejected alternatives explicitly so the decision is legible.

---

## Scaffolding convention

- Self-contained single HTML file at `.claude/mockups/<name>.html`. No build step.
- **Copy the head verbatim from an existing mockup** (`membership-approval.html` or
  `space-folder-sync.html`): the CSS custom-property token block (light + `.dark`), the
  Tailwind CDN + `tailwind.config` color/font mapping, the Google-Fonts link (Manrope +
  Plus Jakarta Sans), the `.device-frame` window chrome (traffic lights + "Mirall"), and
  the light/dark toggle script. These mirror `tailwind.css` / `tailwind.config.js` —
  keep them in sync with `design.md`.
- Icons follow the existing mockups' style (inline **stroke** SVGs). The app ships
  Material Symbols; the mockups approximate with simple SVGs — that is the *one*
  acceptable divergence from production.
- Multiple states per file as `<section>`s, each with a heading + one-line description +
  an a11y note.

---

## Faithfulness checklist (before calling a mockup done)

- [ ] Every modified screen/component was **read in code** and recreated (structure +
      classes + props + real copy + a11y) — not guessed.
- [ ] Every color / spacing / radius / shadow is a `design.md` token; no raw hex, no
      invented scale.
- [ ] New controls reuse existing primitives (`Button` variants, `Toggle`, `Modal`,
      `Avatar`, …).
- [ ] User-facing text is the real locale string, or clearly marked as proposed new copy.
- [ ] Every interactive element has name/role/state (the a11y bar from `.claude/testing.md`).
- [ ] Light **and** dark both render (the toggle works).
- [ ] Proposed-vs-real is annotated; rejected alternatives are labeled.

---

## Anti-patterns (these have bitten us — do not repeat)

- **Inventing a screen/modal from a description** instead of recreating the real
  component. (E.g. guessing the invite modal rather than reproducing `InviteModal.tsx`.)
  Read the code.
- **Surfacing data the user can't act on.** (E.g. a raw public-key "fingerprint · verify
  it's really Bob" — false assurance.) Only render affordances that mean something to a
  real user.
- **A novel aesthetic.** Mockups match Mirall; distinctiveness is not the goal — fidelity
  is. (Do not reach for a generic "frontend design" pass when the task is to extend an
  existing, documented system.)
- **Approximate copy.** Use the locale strings.

---

## References
- `design.md` — the visual language (mandatory grounding truth).
- `.claude/testing.md` §2 — the accessibility bar mockups must depict.
- `src/renderer/**` + `src/renderer/locales/**` — the implemented baseline (always the truth).
- Scaffolding templates: `.claude/mockups/membership-approval.html`,
  `.claude/mockups/space-folder-sync.html`.
