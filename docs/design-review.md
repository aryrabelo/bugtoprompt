# snap-prompt — Phase 4 Design Review

Design-for-AI overlay audit + AI-tells sweep + polish pass over the five overlay
surfaces, followed by an applied-fix pass. Reviewed at commit-time state of:

- `src/overlay/DebugOverlay.tsx` — floating panel + idle FAB + all phases
- `src/overlay/picker/TargetPicker.tsx` — filterable combobox
- `src/overlay/snap/Shutter.tsx` — snap-capture flash
- `src/overlay/caption/CaptionEditor.tsx` — live caption + health badge
- `src/ui/button.tsx` — local Button primitive

Each finding is tagged **Required** / **Recommended** / **Optional** and cites the
design principle it rests on. Line numbers refer to the pre-fix source. The
"Disposition" line records whether the fix was applied or deferred. A roll-up
table is at the end.

The widget styles entirely from the host theme's tokens (`bg-popover`,
`text-muted-foreground`, `border-input`, `bg-primary`, `text-destructive`, the
`green/amber/red-500` status palette, …); there is no local Tailwind or CSS
config (confirmed: no `tailwind.config`, no `*.css`). All fixes stay token-based;
the only hardcoded values live in `Shutter.tsx`, which is intentionally
Tailwind-free and portals raw style.

---

## 4.1 — AUDIT

### Typography

- **[Optional] Type scale is a single step (`text-xs`) everywhere.** Every
  surface renders at `text-xs` (DebugOverlay header `99`, body, picker `146`,
  caption `85`, button `12`). The widget is deliberately compact (a corner HUD),
  so one step is defensible, but the header "Debug capture" (`DebugOverlay.tsx:98`)
  reads at the same size/weight rhythm as body copy — only `font-medium`
  separates them. _Principle: typographic hierarchy._ **Disposition:** documented;
  not changed (compact HUD, intentional).
- **[Optional] No hardcoded font family.** Good — the widget inherits the host
  font; there is no `Inter`/`system-ui` literal anywhere. (AI-tell check, see 4.2.)
- **[Recommended] `tabular-nums` is used for caption timestamps
  (`CaptionEditor.tsx:88`) but NOT for the recording timer
  (`DebugOverlay.tsx:154`).** The mm:ss timer ticks once per second; without
  tabular figures the digits jitter horizontally on each tick. _Principle:
  numeric stability._ **Disposition:** applied — `tabular-nums` added to the timer.

### Color

- **[Optional] Status palette uses raw Tailwind colors, not semantic tokens.**
  `text-red-500` (timer `DebugOverlay.tsx:152`), `text-green-500` / `text-amber-500`
  (badges `CaptionEditor.tsx:54,68`). These are the established convention in the
  package and are listed as accepted by the brief; standard shadcn themes expose
  no `success`/`warning` token, so the palette colors are the pragmatic choice.
  _Principle: token-first color._ **Disposition:** kept as the convention; the new
  inline health indicator (4.3) reuses the SAME `green/amber-500` language for
  consistency.
- **[Optional] No pure `#000`/`#fff` in the Tailwind surfaces** — neutrals come
  from tinted tokens (`bg-popover`, `text-popover-foreground`). Good. The one
  exception was the Shutter veil (`rgba(255,255,255,…)`), addressed in 4.2.

### Spacing & proportions

- **[Recommended] Inconsistent corner-radius language.** The panel is
  `rounded-md` (`DebugOverlay.tsx:95`), the FAB `rounded-full`
  (`DebugOverlay.tsx:82`), but every interactive control is `rounded-none`:
  Button base (`button.tsx:12`), picker input + dropdown
  (`TargetPicker.tsx:146,194`), caption edit field (`CaptionEditor.tsx:93`).
  Square controls inside a `rounded-md` panel read as unfinished and break the
  nesting convention (inner radius ≤ outer radius). _Principle: radius
  consistency / visual nesting._ **Disposition:** applied — interactive controls
  unified to `rounded-sm` (one step inside the panel's `rounded-md`). FAB stays
  `rounded-full` (a pill FAB is a deliberate, conventional shape).
- **[Optional] `kbd` chip uses bare `rounded` (`DebugOverlay.tsx:143`)** — a third
  radius value. Cosmetic; left as-is (decorative inline chip, not a control).
- **[Optional] Spacing is on an even rhythm** (`gap-3` panel, `gap-2` button rows,
  `gap-1.5` inline). Coherent; no change.

### Composition & layout

- **[Required] The panel has a fixed `w-80` (320px) with no width clamp
  (`DebugOverlay.tsx:95`).** At `right-4 bottom-4` (16px insets) the panel needs
  352px of width; on viewports < 352px (small phones, narrow embeds) it overflows
  horizontally. _Principle: responsive containment._ **Disposition:** applied —
  `max-w-[calc(100vw-2rem)]` added so the panel never exceeds the viewport.
- **[Optional] Left-aligned, asymmetric layout** with the recording timer/count on
  a `justify-between` row (`DebugOverlay.tsx:151`) — avoids the center-everything
  AI-slop pattern. Good.

### Visual hierarchy

- **[Optional] Button hierarchy is correct.** Primary actions are filled
  (`Record`, `File issue`), secondary actions `secondary`/`ghost` (`Mark`,
  `Discard`, `Reset`, `New capture`), destructive `Stop` is a soft tinted
  destructive. No "everything is primary" anti-pattern. Good.
- **[Recommended] The streaming-health signal is demoted to plain muted text.**
  `DebugOverlay.tsx:164-167` renders `{markCount} marks · live|rec only` entirely
  in `text-muted-foreground`, with no color or icon to distinguish a HEALTHY live
  stream from a DEGRADED recording-only fallback. Meanwhile `CaptionEditor` ships
  a fully-built green/amber health badge (`CaptionEditor.tsx:51-78`) that the
  overlay never wires in. So the most operationally-important state (is the live
  transcript actually working?) is the least legible. _Principle: hierarchy should
  track importance; never signal state with weight alone._ **Disposition:** applied
  — see 4.3 (inline health dot + color), reusing the badge's palette.

### Contrast (WCAG)

- **[Required] No visible focus indicator on the Button primitive
  (`button.tsx:11-12`).** `BASE` sets no `focus-visible:*` ring; keyboard users
  fall back to whatever the host UA paints (often nothing on `<button>` after a
  reset). Every interactive button in the overlay inherits this gap. _Principle:
  WCAG 2.4.7 Focus Visible._ **Disposition:** applied — token-based
  `focus-visible:ring-2 ring-ring` (offset on popover) added to `BASE`.
- **[Required] FAB and Close-`X` are raw `<button>`s with no focus ring.** FAB
  (`DebugOverlay.tsx:78-85`) has neither hover nor focus affordance; Close
  (`DebugOverlay.tsx:101-108`) changes only text color on hover, nothing on focus.
  _Principle: WCAG 2.4.7; affordance._ **Disposition:** applied — both get
  `focus-visible:ring-2 ring-ring`; FAB gains a `hover:` tint + `transition`.
- **[Optional] Borderline AA on the status palette on LIGHT host themes.**
  `red-500` (~3.3:1), `green-500` (~2.3:1), `amber-500` (~1.9:1) as small text on a
  light `popover` fall below the 4.5:1 AA threshold. On dark themes they pass. Two
  mitigations are in place: (a) red/green/amber are never the SOLE signal — they
  pair with an icon/dot and position; (b) the convention is shared with the
  already-tested badge. _Principle: WCAG 1.4.3; don't rely on color alone (1.4.1)._
  **Disposition:** documented; the new inline indicator adds a dot so the signal is
  not color-only. Shade not darkened to avoid diverging from the tested badge and
  to avoid `dark:` variants whose strategy the host owns.

### Affordances

- **[Recommended] Editable caption lines give no resting affordance
  (`CaptionEditor.tsx:93`).** The review-mode inputs are
  `border-transparent border-b … focus:border-ring`: they look like static text
  until focused, so a user may not realize captions are editable before filing.
  _Principle: affordance / discoverability._ **Disposition:** applied — a faint
  resting `border-input` underline signals editability, strengthening to
  `border-ring` on focus.
- **[Recommended] The combobox chevron never reflects open/closed
  (`TargetPicker.tsx:187`).** A static `ChevronDown` is a weak open/close
  affordance. _Principle: state affordance._ **Disposition:** applied — chevron
  rotates 180° (with `transition-transform`) while the list is open.
- **[Optional] `Snap on click` checkbox is `size-3` (12px)
  (`DebugOverlay.tsx:198`)** — below a comfortable target, though the wrapping
  `<label>` enlarges the hit area. _Principle: target size._ **Disposition:** kept
  (label hit-area is adequate; enlarging the box would unbalance the dense row).

### States

- **[Required] `TargetPicker` swallows fetch failures and renders them as "No
  targets" (`TargetPicker.tsx:80-82, 200-203`).** `listTargets(...).catch()` only
  clears the spinner; a genuine network/permission failure is then
  indistinguishable from a legitimately empty project. The user has no signal that
  anything went wrong. _Principle: explicit error state; never conflate empty with
  error._ **Disposition:** applied — a distinct "Couldn't load targets" failure
  state.
- **[Required] Error phase is a bare red paragraph (`DebugOverlay.tsx:269`).** No
  `role="alert"` (so screen readers never announce the failure) and no icon. The
  most stressful moment in the flow is the least communicated. _Principle: WCAG
  4.1.3 Status Messages; error affordance._ **Disposition:** applied —
  `role="alert"` + a `CircleAlert` icon.
- **[Optional] Loading / empty / no-results / selected states are otherwise well
  covered** in the picker (`TargetPicker.tsx:196-245`) and the overlay's
  saving/done phases. Good.

### Motion

- **[Recommended] No `prefers-reduced-motion` guard anywhere.** The shutter flash
  and the mark-counter scale-pulse animate unconditionally; the recording dot and
  live dot use `animate-pulse`. Users who request reduced motion get none of it
  honored. _Principle: WCAG 2.3.3 Animation from Interactions._ **Disposition:**
  applied — the injected stylesheet now disables/instant-completes the shutter and
  counter animations under `@media (prefers-reduced-motion: reduce)`.
- **[Recommended] Counter pulse over-scales (`scale(1.4)`,
  `Shutter.tsx:23-27`).** A 40% pop on a text line is a large, attention-grabbing
  jump for a passive counter; default `transform-origin: center` also lets it grow
  toward the panel edge. _Principle: motion proportional to importance; restraint._
  **Disposition:** applied — eased to `scale(1.18)`, `transform-origin: right`,
  and the same ease-out-expo curve as the shutter for a unified motion language.
- See 4.2 for the shutter timing/easing adjudication.

### Consistency

- **[Recommended] Two parallel representations of one concept (streaming health).**
  Inline muted text in the overlay vs. the colored badge in `CaptionEditor`. Covered
  under Hierarchy/4.3; resolved by giving the overlay a single colored indicator and
  keeping the badge as a standalone-host feature.
- **[Recommended] Radius language split three ways** — covered under Spacing;
  resolved to `rounded-sm` controls inside the `rounded-md` panel.
- **[Optional] z-index scale is ad hoc** (`z-[9999]` panel/FAB, `99998` shutter,
  `z-50` dropdown — `DebugOverlay.tsx:82,95`, `Shutter.tsx:70`,
  `TargetPicker.tsx:194`). Layering is correct (shutter frames over the panel; the
  dropdown is within the panel's stacking context), just unsystematic. Left as-is.

---

## 4.2 — AI-TELLS SWEEP

### The glassmorphism shutter — DECISION: **REPLACE**

`Shutter.tsx` (pre-fix) painted a full-viewport `rgba(255,255,255,0.2)` veil with
`backdropFilter: blur(4px)` fading over 150ms (`Shutter.tsx:64-79`). This is the
textbook glassmorphism AI-tell (frosted blur, pure-white veil) flagged in the
role's avoid-list, and it has two further problems:

1. **Pure-white veil + blur is the cliché**, and a pure-white flash is
   theme-fragile — near-invisible over a light host UI.
2. **`backdrop-filter` over the full viewport forces the browser to snapshot and
   blur the ENTIRE page** on every capture, an avoidable per-snap compositing cost
   on large/complex host apps.

Rather than merely re-tint the cliché, I replaced it with a **distinct, less-cliché
capture signature: a viewfinder "capture-frame" flash** — a thin double-stroke
inset ring that pulses at the viewport edges (like a camera/screenshot frame),
then fades. Rationale:

- **Distinctive & on-concept** — a framing ring reads explicitly as "this frame was
  captured," which is exactly what a snap is, instead of a generic whiteout.
- **No glassmorphism** — `backdrop-filter`/`blur` removed entirely; this also drops
  the full-viewport blur repaint cost. The page stays fully visible; only the edge
  frame flashes.
- **Theme-robust & WCAG-safe by construction** — a *double* stroke (a tinted
  near-white inner line + a tinted near-dark outer halo) guarantees one of the two
  always contrasts against the host background, light or dark. Neutrals are tinted
  (warm near-white `rgba(252,250,245,…)`, cool near-dark `rgba(20,22,32,…)`), not
  pure `#fff`/`#000`.
- **Non-bounce, brief** — `cubic-bezier(0.22,1,0.36,1)` (ease-out-expo, no
  overshoot), ~160ms, unmounts at 180ms.
- **Reduced-motion aware** — instant under `prefers-reduced-motion: reduce`.
- **Invariants preserved** — still a single full-viewport portal to `document.body`,
  `aria-hidden`, `pointer-events:none`, fires once per `trigger` increment, and the
  ordering contract (`useSession.mark()` bumps `flashTick` strictly AFTER
  `grab()` resolves, `useSession.ts:156-158`) is untouched. The component still owns
  its own injected stylesheet (`snap-shutter-styles`) and remains Tailwind-free, and
  still defines the `snap-count-pulse` keyframe the overlay references.

### Other tells — swept, results

- **Cyan-on-dark + purple gradients:** NOT present. No `cyan`/`violet`/`fuchsia`,
  no gradient utilities anywhere. ✓
- **Uniform card grids / cards-in-cards:** NOT present. The overlay is a single
  panel with stacked sections, no repeated icon-heading-text cards. ✓
- **Generic bounce/elastic easing:** NOT present. Pre-fix motion already used
  `ease-out`; standardized to ease-out-expo. No `cubic-bezier` overshoot, no
  `bounce`. ✓
- **Default Inter / 16px:** NOT present. No font-family literal (inherits host);
  base size is `text-xs`. ✓
- **Glow-everything / decorative gradient text:** NOT present. No
  `drop-shadow`/`text-shadow` glows, no `bg-clip-text` gradient metrics. ✓

---

## 4.3 — POLISH

### Motion timing

- **Shutter:** 160ms `cubic-bezier(0.22,1,0.36,1)` (was 150ms `ease-out` on a
  frosted veil). See 4.2.
- **Mark-counter pulse:** `scale(1.18)`, `right`-anchored, same ease-out-expo,
  ~220ms (was `scale(1.4)` `ease-out` 200ms). Moved from an inline `style`
  animation to a `.snap-count-pulse` class in the injected stylesheet so the
  reduced-motion media query can disable it (inline animations can't be overridden
  by a media query). The `key={flashTick}` remount that re-triggers the animation
  is preserved.
- **Reduced motion:** both animations are neutralized under
  `prefers-reduced-motion: reduce`.

### Interaction states (the 8)

**Combobox (`TargetPicker`):**
- default — placeholder `Select a target…` / selected name. ✓ (kept)
- hover — option rows highlight via `onMouseEnter`→`bg-accent`. ✓ (kept)
- active/selected — `aria-selected` + `font-medium` + check icon. ✓ (kept)
- focus — input opens the list and shows `border-ring`; **added** `aria-controls`
  + `aria-activedescendant` (+ option `id`s) so the active option is announced —
  the WAI-ARIA combobox pattern (WCAG 4.1.2).
- disabled — n/a (picker has no disabled mode).
- loading — `Loading…`. ✓ (kept)
- empty — `No targets`. ✓ (kept)
- error — **added** distinct `Couldn't load targets` (was conflated with empty).
- no-results — `No matches for "q"`. ✓ (kept)

**Buttons (`button.tsx`):** default/hover/disabled present; **added** the missing
`focus-visible` ring. Active(pressed) state left to the host (Optional).

**Snap-on-click toggle:** native checkbox checked/unchecked + native focus ring;
hit area via the wrapping label. Adequate; unchanged.

### Responsive

- Panel is fixed `w-80` bottom-right; **added** `max-w-[calc(100vw-2rem)]` so it
  never overflows a narrow viewport. Internal scroll regions
  (`max-h-32`/`max-h-40`/`max-h-48 overflow-y-auto`) already bound vertical growth.

### Contrast of badges + muted text

- Muted text (`text-muted-foreground`) is token-driven and AA-tuned by the host;
  kept.
- The live/degraded indication is no longer color-only: the overlay status line
  now carries a green/amber **dot + colored word** (matching the `CaptionEditor`
  badge), so the live-vs-degraded distinction survives both low contrast and color
  blindness. The borderline AA of the `-500` palette on light themes is documented
  (4.1 Contrast) and mitigated by never being the sole cue.

---

## Roll-up

| # | Finding | Tag | Disposition |
|---|---------|-----|-------------|
| 1 | Button has no focus-visible ring | Required | Applied |
| 2 | FAB + Close-X no focus ring / FAB no hover | Required | Applied |
| 3 | Panel `w-80` overflows narrow viewports | Required | Applied (`max-w`) |
| 4 | Picker fetch-failure conflated with empty | Required | Applied (failure state) |
| 5 | Error phase: no `role="alert"`, no icon | Required | Applied |
| 6 | Combobox missing `aria-activedescendant`/`aria-controls` | Required | Applied |
| 7 | Glassmorphism shutter (AI-tell) | Required | Applied (REPLACE → capture-frame) |
| 8 | No `prefers-reduced-motion` guard | Required | Applied |
| 9 | Radius language split 3 ways | Recommended | Applied (`rounded-sm` controls) |
| 10 | Streaming health is color-less muted text | Recommended | Applied (dot + color) |
| 11 | Editable caption lines have no resting affordance | Recommended | Applied |
| 12 | Combobox chevron doesn't reflect open state | Recommended | Applied (rotate) |
| 13 | Counter pulse over-scales (1.4) | Recommended | Applied (1.18, eased) |
| 14 | Recording timer not `tabular-nums` | Recommended | Applied |
| 15 | Wire `CaptionEditor` badge into overlay | Recommended | **Deferred** — would duplicate the inline indicator (#10); badge kept for standalone hosts |
| 16 | Panel entrance animation | Optional | Deferred (low value; would add gated motion) |
| 17 | Borderline AA of `-500` status palette on light themes | Optional | Documented; mitigated (not color-only) |
| 18 | Single type step / header weight | Optional | Documented (intentional compact HUD) |
| 19 | `kbd` bare `rounded`, ad-hoc z-index scale | Optional | Documented; unchanged |
| 20 | `Snap on click` checkbox 12px; button active state | Optional | Documented; label hit-area adequate |

**Applied:** 8 Required + 6 Recommended = 14. **Deferred:** 1 Recommended (#15,
with reason) + 1 Optional (#16). **Documented-only:** Optionals #17-20.
