# Nano Arrangement — Mockup Notes

Companion to `PRD.md`. Captures what we learned building the **Milestone 1 mockup**
(`web/src/views/arrangement/`): pitfalls to avoid, shortcuts that must be replaced for the real
thing, and where to reuse code — especially **whole components from the Effect IDE / Sketch IDE**,
since making the two surfaces look and feel the same is a deliberate goal.

> Mockup-only modules (replace/rework for the engine build): `surfaces/fake-binding.ts`,
> `surfaces/film-reel.ts`, `model/fake-data.ts`, the placeholder draws in `arr-monitor.ts`, and
> the synthesized dashboard in `arr-inspector.ts`.

---

## Known pitfalls (hit while building — don't relearn these)

- **Lit host height collapse.** A component whose only content is an absolutely-positioned
  canvas collapses to height 0 unless the host is `position:absolute; inset:0` (or the parent is
  flex). Bit us on `arr-rail-lane` (canvas drew into a 0-px host → blank envelopes). Probe with
  `getBoundingClientRect().height` before assuming a draw bug.
- **Never mutate MobX observables during `render()`.** `FakeBinding` seeding `device.state` in
  its constructor (called from `arr-chain.render()`) threw "uncaught exception in reaction".
  Write to observables only in event handlers / actions; return defaults lazily in render.
- **Signed shift on a hash.** `h >> k` goes negative past 2³¹ → negative array index →
  `undefined is not iterable`. Use `>>>` (`fakeParamsFor`).
- **Canvas `fillStyle` ignores CSS vars.** `ctx.fillStyle = 'var(--app-…)'` is a silent no-op;
  pass real hex in canvas code (kept a few `--app-*`→hex duplications as a result).
- **requestAnimationFrame ordering.** Parent `updated()` can run before child elements relayout,
  so wire geometry read there is a frame stale. The overlay recomputes on a rAF loop to dodge it.
- **Cross-shadow geometry.** You can't `querySelector` through nested shadow roots cleanly. We
  added an **anchor registry** (`anchor-registry.ts`): components register elements by key,
  consumers read `getBoundingClientRect()`. This is the load-bearing trick for the global wire
  overlay and should stay.
- **Dev server.** This workspace's vite always runs on **localhost:5174** — never `pkill vite`;
  point e2e/screenshots there (`ARR_BASE_URL=http://localhost:5174`).

---

## Known shortcomings (mockup shortcuts to replace)

- **No engine.** Everything is fake data + procedural visuals. No worker, no real rendering,
  no real warp precompute, no real rail values. M2 onward per the PRD.
- **No undo/persistence.** The store is `makeAutoObservable` with plain actions; it does **not**
  use the immer/patch history or IndexedDB yet (see Reuse below).
- **Continuous rAF overlay.** `arr-overlay` reconciles wires every frame even when idle — fine
  for a mock, wasteful for real; gate it on "something moved / wires exist".
- **Overlay z-order.** The viewport overlay (z 60) draws wires *over* the bottom clip view; a
  reader wire to an inspector field visually crosses the panel. Clip the overlay region or lower
  its z below the clip view.
- **Dashboard is synthesized.** Inputs are faux SVG knobs (not real `scalar-knob` + binding),
  and a rail read is shown twice (chain field pip *and* dashboard input). Real dashboards should
  expose a curated set distinct from raw device params, with real bindings.
- **Display-only editing.** Automation curves render with nodes but aren't draggable; clip-view
  loop/in-out markers aren't editable; track reordering / group DnD not implemented.
- **Warp is single-source + faked.** One global derived warp from clip bindings; the beat-warp
  lane curve is a direct sine sum, not the integrated tempo the grid actually uses. Reconcile to
  one source of truth (`beat-grid.ts`) when real.
- **Region/clip-view share little with the arrangement transform.** `time-strip` is a *separate*
  linear time view; the arrangement uses `BeatGrid` (warped). Unifying them behind one
  "zoomable gridded time view" abstraction is the stated goal but not yet done.
- **Film thumbnails are procedural** (`film-reel.ts`). Real system needs a decode + thumbnail
  cache keyed by source+frame.

---

## Opportunities for reuse (internal — wire these up for M2)

- **Undo/redo + persistence.** Swap the ad-hoc store mutations for the IDE's immer + forward/
  inverse-patch engine (`state/history.ts` `record()` / `LongEdit`, `applyPatchesToObservable`)
  and IndexedDB (`state/project-store.ts`, `state/idb-store.ts`). The `Composition` doc slots in
  as the undo-able `database` tree.
- **One time-view abstraction.** Generalize `BeatGrid` (warped) and `time-strip`'s linear view
  into a shared transform + a shared gridded-canvas component used by the ruler, arrangement
  grid, clip view, and automation lanes (the PRD's "shared component" goal).
- **Selectable registry.** Adopt the path-keyed `Selectable` interface (`state/types.ts`) +
  `defineSelectable`/`select` with queued promotion (`state/controller.ts`) instead of the
  bespoke `Set<path>` selection, so inspector content routing matches the IDE.
- **Worker diff mirror.** When the engine lands, copy `engine-worker.ts`'s `diffMap` → frame
  channels and `applyPluginStatesDiff` application verbatim for transport/rail/mod telemetry.
- **Lock-step math.** Rail read/write and automation must evaluate through the real
  `web/src/tap-mod.ts` ↔ `native/src/sketch/tap_mod.h` and `envelope.h` pipelines (goldens
  exist) rather than the mock's approximations.

---

## Reuse of **whole components** from the Effect IDE / Sketch IDE

Look-and-feel parity with the IDEs is a goal. These already-built components should be lifted in
(some are already imported; most are not yet):

| Need in arrangement | Reuse from IDE / sketch | Notes |
| --- | --- | --- |
| Effect chain in inspector | **`widgets/column-group.ts`** + **`widgets/columns-view.ts`** | The real effect-card column (category dots, bypass, collapse, param rows, gutter pips). Our `arr-chain` is a thin re-implementation — replace it with `column-group` for true parity. |
| Field editors | **`widgets/scalar-slider`** (already used), **`scalar-knob`**, `field-toggle/-select/-vec/-color/-text`, **`generic-inspector.ts`** | Dashboard knobs should be real `scalar-knob` + a `FieldBinding`. `generic-inspector` builds a whole field set from a schema. |
| Wire / tap drawing + tap card | **`widgets/taps-overlay.ts`** (+ `taps-connect.ts`) | The canonical arcing-wire + marching-ants + fat-hit-path + tap-config card. Our `arr-overlay` mirrors its aesthetic; reconcile to share the actual component/idiom (and `field-layout-manager.ts` for port/pip hit maps). |
| Automation / envelope editing | **`editors/envelope-inspector.ts`** | Real double-click add/remove, drag-to-bend-easing, live input cursor — drop into the clip-view automation mode and track automation lanes instead of the display-only curve. |
| Output monitor / preview | **`views/effect-ide/ide-monitor.ts`**, **`widgets/texture-monitor.ts`** | Replace `arr-monitor`'s placeholder; reuse checkerboard alpha, fit/zoom, transport stats. Also the trace plumbing (`state/trace-controller.ts`). |
| Effect picker (add device) | **`widgets/smart-input.ts`** | Hierarchical dotted-path effect chooser — use for "add source / add effect" in the chain instead of the stub buttons. |
| App shell / panels / splitter | **`views/effect-ide/effect-ide-app.ts`**, **`widgets/splitter.ts`**, **`views/effect-ide/ide-icon-bar.ts`** | Same panel chrome, resizable splitters, icon bar idiom (our resize handle is bespoke). |
| Category color + icons | **`widgets/category-color.ts`** (used), **`widgets/ui-icon.ts`** (used) | Keep. |
| Base reactivity | **`mobx-lit-element.ts`** (used) | Keep. |
| Design tokens / style | **`style.css`**, **`EFFECTS_STYLE_GUIDE.md`** (used) | Keep. |

**Bottom line:** the arrangement currently *re-skins* several IDE concepts (chain cards, wires,
tap popup, monitor, knobs). For the production build, prefer lifting the **actual** IDE
components (`column-group`, `taps-overlay`, `envelope-inspector`, `ide-monitor`, `smart-input`,
`scalar-knob`, `splitter`) so the two surfaces stay byte-for-byte consistent and we don't
maintain two divergent versions of the same widget.
