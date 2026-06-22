# Nano Arrangement — Mockup Notes

Companion to `PRD.md`. Captures what we learned building the **Milestone 1 mockup**
(`web/src/views/arrangement/`): pitfalls to avoid, shortcuts that must be replaced for the real
thing, and where to reuse code — especially **whole components from the Effect IDE / Sketch IDE**,
since making the two surfaces look and feel the same is a deliberate goal.

> **STATUS 2026-06-22:** M1 was a fake-data mockup; most of it is now real (engine, undo +
> disk persistence, real clip chains, editable automation, real dashboard, real thumbnails,
> multi-track compositing). `surfaces/fake-binding.ts` + `surfaces/arr-chain.ts` are RETIRED
> (the inspector mounts the real shared `<column-group>`). Mockup-only leftovers still standing:
> `model/fake-data.ts` (still the boot default — no real empty-state/file-open flow yet) and
> `surfaces/film-reel.ts` (procedural fallback when no decoded thumbnail is available).
> See the per-item status below; the canonical running history lives in the memory note
> `nano-arrangement-project` and the plan file.

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

## Shortcomings — status (M1 shortcuts, what's real now)

**✅ Resolved:**
- ~~No engine~~ — real render via `executor.wasm` (`engine/`: ArrEngine/EngineProxy, engine-bridge,
  clip-sketch). Warped transport clock real (`warp-clock.ts`).
- ~~No undo/persistence~~ — `state/history.ts` immer+patch `DocHistory` + `.nano-arr` files on a
  mounted workspace (`workspace/`). All writes funnel through `store.mutate(desc,recipe[,ck])`.
- ~~Dashboard synthesized~~ — real `<scalar-knob>` (rail-read inputs) + `<spark-chart>` (export
  outputs) via `buildClipFieldBinding` (`arr-column-adapter.ts`).
- ~~Display-only AUTOMATION~~ — editable via `<arr-automation-editor>` wrapping the shared
  `<envelope-graph>` (clip-view + clip/track inspector). Curves eval lock-step (`automation-eval.ts`).
- ~~Film thumbnails procedural~~ — real decode + cache (`media/`, Component D); procedural reel is
  now only the not-yet-decoded fallback.
- **(new) Multi-track compositing** — the monitor plays the timeline: `store.compositeLayersAtBeat`
  (groups/bypass/solo/opacity) → bridge renders engine layers → monitor composites engine + media
  bottom→top at per-track opacity.

**⏳ Still open (real TODOs):**
- **Real rail VALUES.** Rails don't yet modulate: the rail lane sums a MOCK oscillation
  (`arr-rail-lane.contribAt`). NOTE the lock-step `web/src/tap-mod.ts` twin was **DELETED** (zombie;
  modulation telemetry now comes from the native executor via the modulationData channel) — so this
  is a fork: reintroduce a TS evaluator (+goldens) vs. native cross-clip integration. UNDECIDED.
- **Real empty-state / file-open flow.** App still boots `makeFakeComposition()`; Component A
  (workspace mount) is built but not wired into boot.
- **Continuous rAF overlay.** `arr-overlay` reconciles wires every frame even when idle — gate it.
- **Overlay z-order.** Viewport overlay (z 60) draws wires *over* the bottom clip view.
- **Warp single-source + faked.** Beat-warp lane is a direct sine sum, not the integrated tempo the
  grid uses; reconcile to one source of truth in `beat-grid.ts`.
- **Time-view unification.** `time-strip` (linear) vs `BeatGrid` (warped) are separate; unify behind
  one zoomable gridded time view.
- **Other display-only edits.** Clip-view loop/in-out markers; track reorder / group DnD.
- **Compositor features (not holes).** Blend modes (needs a model field) + group-bus effect chains
  (a group's sketch processing its summed children).

---

## Opportunities for reuse (internal)

- ✅ **Undo/redo + persistence.** DONE — `state/history.ts` `DocHistory` (immer+patch, adapted from
  the IDE) + `.nano-arr` files on a mounted workspace (`workspace/`).
- ⏳ **One time-view abstraction.** Still TODO: generalize `BeatGrid` (warped) and `time-strip`'s
  linear view into one shared transform + gridded-canvas (ruler / grid / clip view / automation).
- ◐ **Selectable registry.** Partial — selection is still the bespoke `Set<path>` + `primaryPath`;
  the IDE's path-keyed `Selectable`/`defineSelectable` isn't adopted (the shared `<column-group>`
  routes its own selection through the adapter).
- ✅ **Worker diff mirror.** DONE for modulation telemetry — `onModulationDataDiff` →
  `store.applyModulationDataDiff` mirrors `appState.local.engine.modulationData`.
- ⚠️ **Lock-step math.** automation/rail curves eval through `automation-eval.ts` → `envelope-math.ts`
  (the real `envelope.h` twin). BUT the rail `tap_mod` twin `web/src/tap-mod.ts` was **DELETED** as a
  zombie — there is no TS tap_mod anymore; real rail values are an open architecture fork (see above).

---

## Reuse of **whole components** from the Effect IDE / Sketch IDE

Look-and-feel parity with the IDEs is a goal. These already-built components should be lifted in
(some are already imported; most are not yet):

| Need in arrangement | Reuse from IDE / sketch | Status |
| --- | --- | --- |
| Effect chain in inspector | **`widgets/column-group.ts`** | ✅ DONE — `arr-chain` retired; inspector mounts the real `<column-group>` behind a `ColumnAdapter` (`arr-column-adapter.ts`; caps gate tracing/wiring/smoothing off). |
| Field editors | **`scalar-slider`/`scalar-knob`**, `generic-inspector` | ✅ DONE — column-group's `generic-inspector` param rows + real `<scalar-knob>`/`<spark-chart>` dashboard via `buildClipFieldBinding`. |
| Text rename + autocomplete | **`widgets/editable-label.ts`** (extracted this arc) | ✅ DONE — clip/track names (dblclick-to-edit); shared with the IDE. |
| Rect tracking | **`widgets/field-layout-manager.ts`** | ✅ DONE — anchor-registry delegates to one `FieldLayoutManager` (no second registry). |
| Automation / envelope editing | **`editors/envelope-inspector.ts`** (`<envelope-graph>`) | ✅ DONE — `<arr-automation-editor>` wraps the generic `<envelope-graph>` (clip-view + inspector). |
| Output monitor / preview | **`widgets/texture-monitor.ts`** idioms | ◐ PARTIAL — `arr-monitor` is the real unified compositor (checkerboard + cover-fit) but bespoke (not `texture-monitor`/`ide-monitor`). |
| Wire / tap drawing + tap card | **`widgets/taps-overlay.ts`** (+ `taps-connect.ts`) | ⏳ TODO — `arr-overlay` still re-skins it; caps keep wiring off in the arrangement column. |
| Effect picker (add device) | **`widgets/smart-input.ts`** | ✅ DONE — column-group's header retype/insert uses smart-input (via the adapter's `availableEffects`). |
| App shell / panels / splitter | **`splitter.ts`**, IDE shell | ⏳ TODO — resize handle still bespoke. |
| Category color + icons / reactivity / style | `category-color`, `ui-icon`, `mobx-lit-element`, `style.css` | ✅ used. |

**Bottom line (updated):** the big reuse refactor LANDED — the arrangement now mounts the *actual*
IDE widgets (`column-group`, `scalar-knob`/`spark-chart`, `envelope-graph`, `editable-label`,
`field-layout-manager`, `smart-input`) instead of re-skins. Remaining re-skins: the wire/tap overlay
(`arr-overlay` vs `taps-overlay`), the monitor (bespoke vs `texture-monitor`), and the app
shell/splitter.
