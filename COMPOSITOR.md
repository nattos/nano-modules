# The native compositor: where it stands, and the road from here

The arrangement app's composition engine (`comp::CompExecutor`) runs in one of two places:
- in a browser worker (`ArrEngine`), or
- in a native **`nano_compositor`** process, reached over the bridge WebSocket.

Both sit behind one seam, `web/src/views/arrangement/engine/comp-engine.ts`. The browser engine
stays first-class. It is the second leg of every arrangement test, and it is the engine wherever the
native one doesn't build yet.

This file has two parts:
1. a map of what is built (M0–M2);
2. the thinking behind the next stages (M3 outputs, M4 Windows, M5 remote, Linux/Pi, MIDI/Art-Net
   into the comp).

Everything in the second part is **proposal**, except the passages marked **Decided**. The
user's decisions are also collected at the end.

**Long-term goals:**
- fullscreen outputs;
- no GC between the compositor and its outputs;
- free-running native frame pacing;
- low-jitter Art-Net/DMX;
- Syphon, Spout and NDI;
- remote "media server" deployments: the same binary, on another machine.

---

## Part 1 — what exists (M0–M2, macOS, 2026-09-28)

### Map

| Piece | Where |
|---|---|
| Engine seam (`ownsVideoPump`, `on*` callbacks, `readbackTrace`) | `web/src/views/arrangement/engine/comp-engine.ts` |
| Remote engine (actions in, NBCJ `comp_report` + NBPS/NBPV previews out, `exportFile`) | `engine/remote-comp-engine.ts` |
| Engine choice: URL, then env, then `arrangement.json` `engine`, then native on darwin | `engine/engine-select(-boot).ts`, `electron/main.cjs` `arrangementEngine()` |
| Spawn/kill/restart the process; the dev tree prefers `native/build` | `electron/compositor.cjs` |
| Settings → Engine segmented control | `surfaces/arr-inspector.ts` `renderEngineSetting()` |
| The process: bridge init, runtime acquire, steady-clock render loop | `native/tools/nano_compositor.cpp` |
| Comp instance in the shared runtime; `comp_*` actions; export job stepping | `native/src/bridge/barrel_runtime.cpp` (`createComp`, `renderComp`) |
| Host around `CompExecutor`: seeding, streams table, pump, frame order | `native/src/bridge/comp_host.{h,cpp}` (also drives `comp_test_runner`) |
| Offline MP4 export beside live playback | `native/src/bridge/comp_export.{h,cpp}` |
| FrameSource seam: DXV, ImageIO still, AVFoundation | `native/src/media/frame_source.h`, `dxv_source`, `avf_source.mm` |
| Decode pump: sync (runners, export) or async (a worker thread per clip) | `native/src/media/video_pump.{h,cpp}` |
| H.264 encode (AVAssetWriter, BT.709-tagged) | `native/src/media/video_encoder.mm` |
| Dev-server media download + cache | `native/src/media/media_fetch.mm` |
| Dual-backend UI suites | `web/test/comp-backend.ts` (`forEachCompBackend`), `test/arr-test-helpers.ts` |
| Protocol ctest | `native/tests/test_compositor_protocol.cpp` |

### Measured

- CPU in the desktop app: about 34% native against about 52% for the worker, with previews on the
  IOSurface ring.
- Decode per 1080p frame:
  - DXV: about 0.6 ms;
  - H.264: 1.3 ms sequential, about 24 ms per seek (hence the threaded pump).
- Export: 120 frames of 1080p in 1.1 s.

### Invariants any later stage must keep

These were each learned by breaking them. The details are in memory
(`project_arrangement_native_compositor`).

- **Effects step by the TRANSPORT's motion, never the wall clock.** Paused means a static frame, and
  a scrub means a seek. An output-driven clock (M3) must keep this.
- **Namespaced instance keys.**
  - The live comp's keys are `<key>/`. The export's are `<key>.export/`: a sibling, because a child
    would be pruned.
  - Every published-output read goes through `CompExecutor::instanceHandle`, because
    `effrt_instance_for` mints a stray instance on a miss.
  - Keys crossing into streams are stripped with `comp::bareInstanceKey`.
- **Two CompHosts in one process share global state:** the bundles' streams table and the backend
  surface. `publishClock` rebinds both every frame. A third host (a second output resolution,
  say) inherits this rule.
- **The GPU backend is single-threaded.**
  - Decode threads only `prepare()` on the CPU; `upload()` happens on the render thread.
  - The export is stepped in slices on the render thread, not run on its own thread.
  - Anything new that touches the GPU (present, Syphon publish, pixel-map readback) goes on the
    render thread too.
- **Uploads batched before one submit each need a fresh staging texture.** A shared one is
  last-write-wins.
- **A clip the pump can't open reports READY** (transparent). Otherwise Precise mode stalls.

---

## Part 2 — the road ahead

### M3 — outputs (macOS first)

The M3 question is how composed frames leave the process **without passing through Electron**.
Today the only consumer is the editor's monitor, on the preview ring.

#### Where output config lives: devices

**Decided: outputs are DEVICES**, as part of the user's "devices" push. It extends the MIDI-controller
device model (the Devices tab: a library of definitions with templates, forks and lineage) to
**displays and lights**:
- a device is **defined** once, in the library;
- it is **added to or removed from** a composition;
- **Art-Net DMX is configured this way.**

This also settles the earlier "per machine AND per show" decision:

| Lives in | Holds | Examples |
|---|---|---|
| the **device definition** (library, per machine) | the machine facts | which physical screen, a Syphon server name, a DMX node's IP / universe / broadcast, the fixture layout, colour format, gamma, output latency |
| the **placement** in a composition (per show) | the show facts | which port feeds the device, its enabled state, any per-output processing |

**A device is ports at the edge of the wire graph.**
- A **display** has a texture input.
- A **light** has a texture input that its pixel map samples, plus per-channel scalar inputs for
  non-pixel fixtures (dimmer, colour, pan/tilt as wire destinations).
- **Input devices** have outputs: MIDI controls, an Art-Net input (e.g. beatsync's drum triggers),
  and an audio/FFT source.

The arrangement's **Composition I/O mode** (the next arrangement feature: per-track ports routed with
the normal wires) should treat a device port as just another wire endpoint. Then feeding an output
is a wire, not a second routing system, and an output's source can be any port, not only the master
composite.

Consequences for the compositor:
- The compositor receives the composition's device placements with the document. It gets the device
  definitions they reference from the library: a settings file per device kind, following the
  settings-files conventions, the way `midi-devices.json` already reaches the barrel runtime
  (`DESKTOP.md` § Settings files).
- **A missing device is an unplugged cable, not an error.** A show opened on a machine without one
  of its displays or light nodes keeps running, and those wires go inert. Hotplug (a display
  appearing, a node coming online) re-binds without a reload.
- **Identify displays by CGDisplay UUID** (`CGDisplayCreateUUIDFromDisplayID`), never by index.
  Indices reshuffle on hotplug and across reboots. That class of bug already bit us (see the memory
  note on DisplayLink breaking Resolume's display output).
- The compositor answers a `comp_displays` action (name, UUID, bounds, refresh rate) so the
  library's display-device editor can list real screens. Each display and light device has an
  **identify** action: paint the display's name, or walk a light's pixels.
- Every device placement can be previewed in the editor from the preview ring. A light is drawn as
  its fixture layout.

**Decided (2026-09-28): visual templates, instantiated into exact devices.** This borrows the MIDI
library's concept of a template that *looks like* the hardware:
- an LED bar is drawn as a long bar;
- a monitor is drawn as a flat panel;
- a template is instantiated into an exact device (this bar, at this address).

**Displays stay generic:** "Display 1", "Display 2", and outputs like Syphon. Their resolution has an
**auto** mode that follows what is detected. Reconciling "Display 1" with never-by-index:
- the device is a portable *slot* that travels with the show;
- each machine remembers which physical screen fills it, by CGDisplay UUID;
- the ordinal is only the fallback when that UUID isn't present;
- `comp_displays` reports detected size and refresh, and hotplug updates auto-sized displays.

**Decided: no per-output sketch for now.** Per-output colour correction is attractive, but it
complicates the UI. Revisit later.

**Decided (2026-09-29), revised for lights the same day: template → type → rig.** Lights shipped
with THREE layers: a rig slot holds a type plus an address, so the address is the physical bar and
there is no separate unit object (swap = exchange two slots' addresses, in the rig). The four-layer
wording below stays as the general frame (a display's unit may still earn its keep: a projector's
usable region matched by EDID).

The model has four layers, with the same words for every kind:
- **template**: in code, a parametric shape (`light.strip` {segments, px per segment, colour
  format}, `display.screen`, the MIDI drivers);
- **type**: in the library, a template with its parameters filled in ("24 V bar: 12 seg × 5 px,
  RGBW");
- **unit**: in the library, one physical thing, i.e. its address plus the corrections that belong
  to that hardware. A projector's usable region is matched by EDID and applies whichever slot it
  fills;
- **rig**: in the library, slots with a default layout and a default unit per slot ("four bars as
  vertical strips").

A show holds **placements** (include + enable). A placement follows the library until the show edits
it, then becomes a per-show copy (lazy fork).
- **Swap** exchanges units between slots.
- **Identify and test patterns** are transient.
- **A light samples the main output** unless a route feeds its input.
- The custom 24 V hardware speaks Art-Net / DMX.

**Decided: the Devices view + optional timeline rows** (revised 2026-09-29 after using D1). The
arrangement's main area switches between the timeline and the Devices panel (Remote Control's, so
layouts and muscle memory carry over); devices wire from there into the inspector. A device can
also be shown as a row under the tracks (a glance at its state, and a wire source near the timeline),
but a MIDI wire never needs one. Mid-wire, hovering the `Timeline | Devices` switch flips the view —
the path texture devices (lights, displays) will need. The order is D2 lights (SHIPPED — see Art-Net
/ DMX output below), D3 displays (SHIPPED — see Display outputs below), D4 inputs (Art-Net in, FFT).

#### Display outputs — SHIPPED (devices D3, 2026-09-29, macOS)

As built (the design notes follow, below):
- **Portable slots, per-machine screens.** A display is a slot — `display.<n>`, "Display 1" and
  "Display 2" always exist — that a show places (`DevicePlacement` kind `display`, with `enabled`
  and `fit: fit | fill | stretch`). This machine's library (`display-devices.json`,
  `web/src/displays/display-types.ts`) says which screen fills it: a CGDisplay UUID, or automatic
  (Display N = the Nth screen that ISN'T the main one, so a fresh machine never covers the editor),
  or rehearse in a **window** instead. A remembered screen that's gone falls back to automatic; no
  screen at all = inert (an unplugged cable). The page sends the resolved plan
  (`display-plan.ts` → `comp_displays`, sticky); the compositor binds screens itself
  (`comp_displays.cpp resolveDisplayScreen`, lock-step with the page's), so a hotplug re-binds at
  once.
- **What it shows** is the device route, as for lights: `SketchBuild.deviceSources` /
  `CompExecutor::deviceSourceTexture` (renamed from the light-only names; goldens unchanged),
  else the composite.
- **`GPUBackend` present API** (Metal): `createPresentTarget(CAMetalLayer*)` /
  `createOffscreenPresentTarget(w, h)` / `presentScaled(target, src, Fit|Fill|Stretch)` — clear to
  black, the Lanczos scaler with a scale transform (+ a clip rect for Fit; MPS places the source
  relative to the clip's origin), `presentDrawable`. Two presents in flight = SKIP, never block.
  The layer is BGRA8 (as previews are), `displaySyncEnabled`, 3 drawables.
- **`bridge/comp_displays.h` `DisplayRunner`**, owned by `CompHost` beside the `LightRunner`: after
  each submitted frame, each enabled display presents its source. It never touches a window —
  a `DisplaySurfaces` provider does: the compositor process's AppKit code
  (`native/tools/compositor/display_windows_mac.mm`, over `bridge_api.h`
  `bridge_comp_set_display_provider` — AppKit stays out of `libbridge_server`, so the barrel in
  Resolume can never open a window), or `OffscreenDisplays` (tests).
- **The process** (`nano_compositor.cpp`): the render thread owns the RUNTIME start to finish
  (WAMR's per-thread environment: wasm must run on the thread that brought the runtime up —
  rendering from another thread silently draws nothing) and is the only GPU thread. The main thread
  owns the windows, headless (no `NSApplication`, no Dock icon) until the first is wanted, then an
  Accessory app. Fullscreen = a borderless window over the whole screen (menu bar and Dock
  included), never key; window mode = a normal window (closing it turns the display off — one undo
  step; moving it is remembered); identify = a big label for 3 s. Screens by CGDisplay UUID, hotplug
  via `CGDisplayRegisterReconfigurationCallback`. While a display is up, the first one's display
  link paces the render thread (capped at `--hz`), and dt comes from its timestamps.
- **Report**: `screens` (on connect + hotplug), `displayStatus` (per placement: showing / window /
  opening / no-screen / off, size, fps; offscreen targets add a 16×16 probe), `displayEvents`
  (closed / moved / identified).
- **Master output switch** (page, `output-master.ts`, the Devices panel's header): OFF at every
  launch, never persisted; off, no display shows (`plan.armed` false → the runner wants nothing,
  status `disarmed`) and every light is planned off. **⌘⇧D** ("Disable Output", Resolume's chord)
  turns it off — in the page, and, while any output window is up, as a Carbon system hotkey in the
  compositor (so it works whichever window is in front): it closes every output at once, reports
  `disableOutput`, and opens nothing again until the page has sent an unarmed plan.
- **Page**: while a display shows the show, the engine renders at the composition's FULL resolution
  (not the 1280 preview cap). The Live button pulses while Precise is on and any display or light
  output is live.
- **Tests never open a window**: `NANO_DISPLAY_REDIRECT=offscreen` (+ `NANO_FAKE_SCREENS`, a JSON
  screen list) presents offscreen — ctest, `comp-backend.ts`, and hidden Electron launches set it.
  `test_comp_displays` (fit/fill/stretch pixels, routes, binding), `test_compositor_protocol`,
  e2e `arrangement-displays`.
- Windows: M4 step 6 below (swap chains, Win32 windows, Spout).
- Not yet: a crop / usable region per projector, per-output colour.

#### The present API (`GPUBackend`) — design notes

Add a small, optional surface, next to `createSharedSurface` / `blitScaledToSurfaceAsync`:

```cpp
virtual int32_t createPresentTarget(void* nativeLayer, uint32_t w, uint32_t h);  // CAMetalLayer* / HWND
virtual void    resizePresentTarget(int32_t target, uint32_t w, uint32_t h);
virtual bool    present(int32_t target, int32_t srcTexture, const float crop[4]);  // scale+crop blit, then present
```

- **Metal:** `nextDrawable` → one render pass with the existing scaled-blit shader (HLSL-authored,
  per the executor-shaders rule) → `presentDrawable` → commit.
  - Set `CAMetalLayer.maximumDrawableCount = 2` and `displaySyncEnabled = YES` for fullscreen.
  - If no drawable is free, **skip the present, don't block**. The render loop mustn't stall on a
    slow display.
- **D3D11 (M4):** a flip-model swap chain with
  `DXGI_SWAP_CHAIN_FLAG_FRAME_LATENCY_WAITABLE_OBJECT`, and the same blit.
- Colour: outputs are sRGB-encoded 8-bit, as previews are. Wide gamut and HDR are out of scope. If
  they come, it's a per-output format.

#### Threading and pacing: the loop must move — design notes (done: see Display outputs)

`nano_compositor.cpp` runs its render loop **on the main thread** with `sleep_until`. AppKit windows
need the main thread, so:
- the main thread runs `NSApplication`, with activation policy **Accessory**: no Dock icon, no menu
  bar. Its only jobs are window lifecycle, display hotplug
  (`NSApplicationDidChangeScreenParametersNotification`) and cursor hiding;
- the render loop moves to a dedicated thread, which becomes the only GPU thread. The invariant above
  holds, because the main thread never touches the backend. It only hands the render thread a
  `CAMetalLayer*`;
- **headless stays possible.** Don't touch `NSApp` until the first window output is enabled, so tests
  and remote deployments without displays behave exactly as today.

**Pacing:**
- With no display outputs, the steady clock stays as it is.
- With display outputs, one of them is the **master**. Its display link wakes the render thread
  (`CADisplayLink` from `NSScreen.displayLinkWithTarget:` on macOS 14+, otherwise `CVDisplayLink`).
  The other outputs present the latest frame at their own rate.
- dt comes from the link's timestamps (target presentation time deltas), not `now()`. The transport
  still advances by `positionSec` deltas, so this only changes how smooth the clock is, not the
  semantics.
- **Precise vs Live:** Precise waits for decode, which on a projector means a missed vsync (a visible
  hitch). Live keeps the last frame and never misses a present.

  **Decided:** while any output is enabled and the transport is in Precise, the **Live button flashes**
  as a nudge. Nothing switches automatically, and there is no dialog.

#### Syphon — SHIPPED (2026-09-30)

As built: a display slot's MODE is fullscreen, window, or **syphon** (this machine's library). A
Syphon display is a server named after the slot, listed under the app "Nano Modules" (the process
sets its name), publishing the show's frame at the render size (full resolution while a display
is live). Syphon's protocol core is VENDORED unmodified (`native/third_party/syphon`, BSD —
server/client base, messaging; no GL/Metal renderers) as `syphon_core`, linked only into the
`nano_compositor` process and its tests — never `libbridge_server` (Resolume loads its own
Syphon.framework). `tools/compositor/syphon_outputs_mac.mm` runs the servers on the main thread
(Syphon swaps its surface and publishes without a lock); the runner presents into the server's
IOSurface (`createSurfacePresentTarget`) and `presentScaled`'s completion publishes (hopping to
the main thread). ⌘⇧D stops them too. Tests: `test_syphon_outputs` (a private server → an
in-process client → the pixels), `test_comp_displays` (render size, a publish per frame),
e2e native leg (offscreen redirect).

Not done, by decision: hiding the cursor over a fullscreen output. Only the frontmost app may hide
it and an output never takes focus; the private "SetsCursorInBackground" workaround had no effect
on macOS 26 (Resolume has the same limit), so the pointer stays visible.

The original notes:

- The Metal backend already renders into IOSurface-backed textures for the preview ring.
  `SyphonMetalServer` (Syphon.framework, BSD) publishes a texture from our `MTLDevice`
  (`nativeDevice()`).
- Link the framework and stage it in the resource root's `bin/` with an rpath, the way the
  compositor binary is staged.
- A Syphon output is a display-like device (a texture input). The server is named by its device
  definition, and one server runs per placed device.
- Publish on the render thread right after the frame's submit.
- Test: a ctest that runs a `SyphonMetalClient` in-process and reads a known colour.

#### Art-Net / DMX output (pixel mapping) — SHIPPED (devices D2, 2026-09-29)

As built:
- **The page resolves, the compositor maps.** The arrangement resolves its show (light placements,
  per-slot layout) against this machine's library into a flat PLAN — fixtures, each an address plus
  one normalized footprint per pixel (`web/src/lights/light-plan.ts`) — and sends it as
  `comp_lights` (sticky, replayed on reconnect). What a light SAMPLES is the document's: a route
  `{kind:'device', placementId}` from an out port, resolved by the builder into
  `SketchBuild.deviceSources` (no wire, so the goldens are untouched) and read as
  `CompExecutor::deviceSourceTexture` (materialised through the barrier predicate); unrouted, the
  composite. Solo never cuts a light's source.
- **`native/src/lights/light_map.h`** (pure): footprint box-averaging, gamma, channel order, RGBW
  (w = min), never spilling past channel 512, and the test patterns.
- **`bridge/comp_lights.h` `LightRunner`**, owned by `CompHost`: after each submitted frame, one
  async Lanczos readback per source texture (long edge 256–1024, sized so the thinnest footprint
  spans ~2 texels); the callback maps and hands the DMX to a sink.
- **`artnet/artnet_sender`**: latest-wins, a 40 Hz thread (ArtDmx per universe, one ArtSync per
  destination). Frames are keyed (interface, destination, universe): `""` is Auto (one unbound
  socket, `broadcast` = 255.255.255.255), a named interface gets its own socket bound to it
  (`IP_BOUND_IF` on macOS) and `broadcast` becomes that interface's directed broadcast — an
  unknown / down / broadcast-less interface is an error in `lightStatus`, never the global
  broadcast. `NANO_ARTNET_REDIRECT=host:port` sends everything to one place from the unbound
  socket — the test compositors (ctest, `comp-backend.ts`) always set it.
- **Networks** (page-side): a library row choosing the interface and patching destinations on site
  (rebase unicast onto a subnet, exact overrides); `light-plan.ts` resolves each fixture to its
  final `dest` + `iface`, so the compositor never sees a network. Built in: Auto, and Loopback —
  iface `loopback`, which the page resolves to 127.0.0.1 (a 127.x kept, ports kept) on the unbound
  socket, so it works on every OS, Windows included.
- **Report**: `comp_report.lights` (the colours each light shows, ≤30 Hz), `lightStatus`, and
  `netIfaces` (this machine's IPv4 interfaces, for a network's picker; on connect + on change).
  Windows lists none yet, so only Auto works there.
- Tests: `test_light_map`, `test_artnet_sender` (loopback), `test_comp_lights` (GPU, capture sink),
  `test_compositor_protocol` (the process transmits to the redirect), e2e `arrangement-lights`.
- Not yet: ArtPoll discovery, a logical-canvas mode (render at the grid instead of sampling a big
  frame), per-channel (non-pixel) fixtures as wire destinations, output latency compensation.

The original design notes:

- **A separate transmitter.** `artnet/artnet_host.h` is a *receiver* with a hard rule: it never
  transmits, because it co-binds Resolume's 6454. Output needs its own socket on an ephemeral port,
  unicast to configured nodes, with ArtPoll discovery as an opt-in extra.
- **The GPU half:** a compute pass samples the composition at the pixel map's points (LED positions,
  normalized) into a small buffer, followed by an **async readback**. The existing
  `readbackTextureScaledAsync` / preview-drain machinery is the model. This costs one frame of
  latency, and the render thread never waits on it.
- **The CPU half:** a transmitter thread sends the latest mapped buffer at a fixed rate (the spec
  caps a universe at about 44 Hz), followed by an ArtSync. The DMX cadence then stays steady even
  when the render thread hitches. That is the "low-jitter" goal.
- **Decided: pixel maps are part of a LIGHT device's definition**, a new model (not the lights
  bundle's). A definition holds:
  - the fixtures and their layout;
  - the colour format (RGB / RGBW, channel order);
  - gamma;
  - start channels and universe;
  - target (unicast / broadcast) and output latency.

  The user has more to say on its shape before any of it is built.
- Consider a **logical canvas**: a light device declares its pixel grid (e.g. 4 bars × 10 px), and
  whatever feeds it renders at that size. Sampling regions of a large frame stays as the other mode,
  for mapping LEDs onto video. The Resolume shows rendered 1920×1080 only to sample 4 × 32-px strips
  of it, because the effects already think in the 4 × 10 grid.

#### NDI

**Decided: not now.** Syphon and Spout cover it. The NDI SDK is proprietary, with redistribution
terms, so revisiting it is a licensing decision before it is an engineering one. Technically it's a CPU path (BGRA/UYVY frames into `NDIlib_send`) fed by the same
async readback as Art-Net, at output resolution. It fits after Syphon and Art-Net.

#### Testing M3

- Present, Syphon and the transmitter are thin. What gets tested is the frame they're handed.
- `present()`'s crop/scale blit is testable by presenting into an offscreen target and reading it
  back.
- Art-Net output: a ctest with a loopback UDP receiver that checks universe contents against a
  known composition, plus a timing test (send cadence stays within ±2 ms while the render thread is
  artificially stalled).
- The dual-backend UI suites don't change. Outputs are native-only, like the video decode legs were.

---

### MIDI and Art-Net *into* the comp — SHIPPED for MIDI (devices D1, 2026-09-29)

What was built:
- **Authoring**: the Devices view (Remote Control's panel in the arrangement's main area, over a
  `DevicesHost`), W-mode wires from a control to any input field or a track's fader, and optional
  timeline rows (`Composition.devices`). See the arrangement PRD ("Devices").
- **The builder** keeps any `midi:<uuid>` wire (src verbatim) at every fold site
  (`Builder::srcFoldable`); a placement is only a timeline row, not a gate.
- **The executor**: `CompExecutor::setExternalScalars` / `setInjectedScalars` forward both tables to
  the composite executor and survive `resetInternalExecutor`. **Decided: the injected table is keyed
  by the BUILT sketch's bare keys** (`clip_<clip>_<dev>`); the namespace prefixes the shared instance
  pool, never the sketch. Pinned by `test_comp_render` `[comp_devices]`.
- **The hosts**:
  - Native: `renderComp` feeds `MidiHost` (with `pollMidi`) and `ArtNetHost` behind the barrel's
    version gates. The Art-Net listener opens only once the build holds a `control.artnet` card, and
    it re-reads on a structure change.
  - Web: the arrangement page runs `midiController` against its own document and pushes the lowered
    table to the worker (`comp_set_external_scalars`). Toward the native compositor it mirrors only
    the library and the simulation (`/global/midi_devices`, `/global/midi_sim`).

Still open:
- **Art-Net into the web arrangement.** The worker can take the table (`comp_set_injected_scalars`),
  but nothing feeds it yet. That arrives with the Art-Net input device (D4).
- **Latency is the native engine's advantage here.** There's no postMessage hop, and the MIDI thread
  is in the same process. Measure input→photon once present exists (M3); it's a selling point worth
  a number.

---

### M4 — Windows

Windows runs on real hardware now: an ROG Ally (one AMD GPU), reached over SSH, with the binaries
cross-built on the Mac (`native/build-win`, the zig toolchain) and copied across. `WINDOWS.md` and
memory (`project_windows_d3d11_port`) record what already ran on D3D11 before the compositor:
- the executor, comp render and FFGL plugin build;
- the executor under WAMR, pixel-identical;
- the GL↔D3D share in the plugin.

**Decided: general video formats are required.** A DXV-only compositor is a stepping stone for
running the tests, NOT a milestone to ship. Windows goes native only once Media Foundation decode
works. Order:

1. **`nano_media` split into a portable core plus a platform layer — DONE (2026-09-30).**
   - Portable: `dxv_source`, `frame_blitter`, `frame_source` routing, `video_pump`, the DXV
     demux/LZ. The two blits are HLSL now (`src/media/shaders/`, baked to SPIR-V, translated per
     backend like the executor's), each with a real sampler binding.
   - Apple: `avf_source.mm` (stills + AVFoundation video), `media_fetch.mm`, `video_encoder.mm`.
   - Windows: `wic_source.cpp` (stills, straight-alpha RGBA8 straight out of WIC),
     `media_fetch_win.cpp` (WinHTTP, so the dev server's fixtures load), `video_encoder_win.cpp`
     (refuses at open: "MP4 export isn't available on Windows yet").
   - `comp_host` + `nano_compositor.exe` build and run: D3D11 on the AMD GPU, 157 effects, a comp
     instance, a clean exit on stdin EOF. No display windows yet (`display_windows_none.cpp`).
   - Tests: DXV decode, stills, the pump (incl. the placement blit, on DXV and a still), comp host,
     lights and media refs pass on Windows. What Windows can't do yet SKIPs BY NAME
     (`NANO_REQUIRE_VIDEO_DECODE` / `_ENCODE` in `tests/wasm_paths.h`, and the present API in
     `test_comp_displays`), so flipping `kPlatformDecodesVideo` is what turns step 4's tests on.
     `NANO_WASM_DIR` / `NANO_TEST_MEDIA_DIR` point a staged run at its copies.
2. **Run the native legs of the arrangement suites on Windows — DONE (2026-09-30),** with previews
   on the lanes (NBPC), against the real machine over the LAN:
   - `native/tools/win_remote.sh push` cross-builds and stages the compositor there;
     `NANO_REMOTE_COMPOSITOR=user@host` makes `test/comp-backend.ts` start it over SSH (port 8091,
     lanes 8092–8099); `web/scripts/lan-forward.mjs` puts the dev server on the LAN, since the
     compositor fetches media from the page's origin (`GPU_TEST_BASE_URL=http://<lan-ip>:5174`).
   - Every engine suite's native leg passes there. What Windows can't do yet is skipped BY NAME
     (`windowsGap`): H.264 decode (step 4), MP4 encode (step 5), present + Syphon/Spout (step 6) —
     all three since done and un-gapped — and the lights suite's DMX listener (its redirect is the remote machine's loopback).
   - What it found, all fixed: FXC made a cold start 26 s (a DXBC disk cache, `<dataRoot>/Cache/
     Shaders` — warm start 1 s); ixwebsocket's Windows poll could stop READING a connection for
     good after one oversized reply (patched to its level-triggered path,
     `cmake/patch-ixwebsocket-windows.sh`); and the harness raced the engine's effect catalog,
     which only showed across a LAN.
3. **Shared preview surfaces on D3D11 — DONE (2026-09-30).** The desktop app's previews reach the
   page GPU to GPU on Windows too, and Remote Control's do with the D3D11 barrel (the same
   `publishSurfaceFrame`; not yet run against a Windows Resolume).
   - `createSharedSurface` (`d3d11_backend.cpp`): a BGRA8 texture, `MISC_SHARED |
     MISC_SHARED_NTHANDLE`, no keyed mutex, shared under a NAME, `Local\nano_surf_<pid>_<serial>`.
     The NBPS token is pid·2^24 + serial: below 2^53 so it survives a JS number, and a serial is
     never reused (a handle value is, the moment one closes — an editor would keep showing a
     surface it imported earlier under the same number). `gpu/shared_surface_win.h` holds the
     scheme and the consumer's open; producer, addon and test all include it.
   - The addon's Windows half opens the name with `D3DKMTOpenNtHandleFromName` (gdi32; the
     session's `BaseNamedObjects` path, no D3D device) and hands Electron `handle: { ntHandle }`.
     It is cross-built with zig (`web/native/build.sh`) and resolves `napi_*` from the host
     executable at run time, so there is no `node.lib`.
   - **Completion:** an `ID3D11Fence` signalled after the blit, waited on by a thread of the
     backend's own, which then runs `done`. That is Metal's completion handler, and it never
     blocks the render thread; an event query would have to be polled on the context's thread.
     No fence (pre-1703 Windows) means no sharing: lanes.
   - The blit is a GPU scaler (one triangle, a grid of bilinear taps over each output pixel's
     footprint; the RTV does RGBA→BGRA). The LANES now use it too: `readbackTextureScaled` used
     to read the whole frame back and box-filter it on the CPU.
   - **Electron needs GPU compositing** to import: without it `importSharedTexture` dereferences
     a null shared-image context and the app aborts on the first preview. That is any session
     where Chromium falls back to software, e.g. an SSH session (session 0). `main.cjs` checks
     `app.getGPUFeatureStatus().gpu_compositing` at support time and before each import, and the
     page turns surfaces off after three failed imports in a row (`MAX_IMPORT_FAILURES`), so
     the requests go back to the lanes. Before this, a failed import just left the monitor black.
   - Measured on the Ally, 1280×720 at 31 fps (hidden window), as % of one core: lanes put
     Electron at 27% and the compositor at 34.5%; surfaces put them at 14% and 9%.
   - `web/test-tools/surface_check.mjs` checks a running app over CDP (or an SSH tunnel). It
     compares an orange top-left quadrant in the preview texture against the engine's own
     readback. It passes on the Ally (desktop session) and on macOS; `test_shared_surface` is
     portable now and reads the surface the consumer's way (by name, on a second device).
   - Still open: the **adapter trap**. There's no LUID check yet, so on a hybrid-GPU laptop where
     Chromium and the producer pick different GPUs, the imports fail and the page falls back to
     lanes. That's safe, but the fallback path hasn't been exercised on real hybrid hardware.
4. **Media Foundation decode — DONE (2026-09-30)** (`src/media/mf_source.cpp`, `MfVideoSource`).
   - `IMFSourceReader` → RGB32, read back and repacked as opaque BGRA8 in `prepare()`, one
     `writeTexture` in `upload()` — AVF's CPU-buffer split. Random access exactly as AVF: read
     forward within ~a second, else seek; frame index = PTS (from the FIRST frame's — an MP4's first
     PTS isn't 0) × fps. Seeks aim half a frame early and are clamped inside `MF_PD_DURATION`
     (the last frames' times lie past it); a final sample can arrive WITH the end-of-stream flag.
   - Hardware decode + colour conversion (DXVA) on a PRIVATE multithread-protected D3D11 device
     behind an `IMFDXGIDeviceManager` — never the engine's device. Software MF seeked 10x slower
     than AVF (231 ms vs 23 on a 720p single-IDR clip); DXVA: 64 ms. `NANO_MF_SOFTWARE=1` forces
     software.
   - COM/MF are process-wide (`CoIncrementMTAUsage` + one `MFStartup`), never torn down: a
     per-thread teardown in a thread_local destructor runs under the loader lock and deadlocked the
     pump's decode threads.
   - Pinned by the same `test_h264_ramp.mp4` exactness test (forward, backward, mid-GOP) and the
     async pump cases, on the Ally; the web suites' H.264 cases run there too.
   - Still to do: skip the RGB32 conversion of frames a seek decodes past (read native NV12, convert
     only the wanted one) — the remaining 3x on seeks.
5. **Media Foundation encode — DONE (2026-09-30)** (`src/media/video_encoder_win.cpp`).
   - `IMFSinkWriter` → H.264 High in MP4, the requested/derived bitrate, rational frame times,
     tagged BT.709 (primaries, transfer, matrix, TV range). A keyframe about every two seconds via
     `CODECAPI_AVEncMPVGOPSize` in `SetInputMediaType`'s encoding parameters (the output type's
     `MF_MT_MAX_KEYFRAME_SPACING` is ignored).
   - Frames go in as NV12 converted by US with the BT.709 matrix: fed RGB32, the sink writer's
     inserted converter uses BT.601 whatever the tags say (decoded back, green came out 216).
   - `test_comp_export` is the contract and passes on the Ally; a Windows export decodes to the
     same colours under AVFoundation. The web export e2e is a remote gap only because its output
     path is checked on the harness's machine.
6. **Outputs on Windows — DONE (2026-09-30).**
   - **Present** (`d3d11_backend.cpp`): a window target is a flip-model swap chain on the
     provider's HWND — BGRA8, 3 buffers, a frame-latency waitable object at 2 (a present that finds
     it unsignalled is SKIPPED, never waited on, like Metal's two-in-flight rule), buffers resized
     to the client size at each present, `Present(1, 0)`. Offscreen targets are BGRA8 textures;
     a shared target opens another API's legacy share handle. Fit / Fill / Stretch are viewports
     on the preview scaler (`scaleIntoRect`; the scissor clips a Fill's overhang).
   - **Windows** (`tools/compositor/display_windows_win.cpp`): screens from `QueryDisplayConfig`,
     one per source, identified by the monitor's DEVICE PATH, named by EDID (an internal panel is
     "Built-in Display" — its EDID name is a part number), physical pixels under per-monitor DPI
     awareness v2, hotplug via `WM_DISPLAYCHANGE` (broadcast to top-level windows only — the
     control window is a hidden top-level one). Fullscreen = a topmost `WS_POPUP` over the monitor,
     `WS_EX_NOACTIVATE` (never takes focus), not in Alt+Tab; window mode, identify and
     Ctrl+Shift+D (`RegisterHotKey` while any output is up) as on macOS; no quit chord. A closed
     window is hidden at once and destroyed 2 s later (the render thread may still present to it
     for a frame), and the main thread keeps pumping while the render thread shuts down.
   - **Pacing**: a thread waits on the first output's `IDXGIOutput::WaitForVBlank` and ticks the
     render thread at most `--hz` times a second — unless the output's refresh is VARIABLE
     (FreeSync / G-Sync, which Windows applies to a fullscreen flip-model window): the panel then
     refreshes when we present, and pacing on its vblanks feeds back (the Ally's 120 Hz panel
     settled at ~47 fps). Seen as far fewer vblanks than the nominal rate (< 85%), the render loop
     keeps its own clock and the panel follows it (~66 vblanks/s, 60 fps); back near nominal
     (≥ 95%: a window, a fixed projector) vblanks pace again. `NANO_DISPLAY_TRACE=1` logs the rate.
   - **Shown with `SetWindowPos`, never `ShowWindow`**: a process's first `ShowWindow` takes the
     launcher's STARTUPINFO show state instead — maximised from a shortcut, HIDDEN from Electron
     (`windowsHide`). A rehearsal window passes through the topmost band on the way up, or it
     opens behind the editor (another process's foreground window). A fullscreen output is marked
     with `ITaskbarList2::MarkFullscreenWindow`, or the taskbar stays over it (topmost alone
     isn't enough for a window that never activates).
   - **Spout** (`tools/compositor/spout_outputs_win.cpp`): the vendored SENDER core
     (`third_party/spout`: names, sender info, frame count — not SpoutDX, whose model is "copy
     your texture in"). The sender's BGRA8 legacy-shared texture is made on a device of the
     process's own, on the engine's adapter (`gpu/d3d11_adapter_win.h` — `NANO_D3D_ADAPTER`'s
     matcher, now shared), and the engine presents straight into it; `publish` bumps Spout's frame
     count (a no-op unless SpoutSettings turned counting on — receivers poll otherwise). The
     page offers `spout` instead of `syphon` because the engine says so (`comp_report.shareMode`).
   - **Linking**: the Windows compositor links libbridge_server through an import library of
     `bridge_api.h`'s functions only. The DLL auto-exports everything, dllcrt2's `atexit` included
     (zig names the CRT objects `.obj`, so MinGW's by-name exclusion misses them), and once Spout's
     static destructors referenced `atexit` the exe got two.
   - Verified on the Ally: `test_comp_displays` (all 7, incl. a swap chain on a never-shown window —
     desktop session; session 0 has no DWM: `DXGI_ERROR_NOT_CURRENTLY_AVAILABLE`),
     `test_spout_outputs` (a receiver finds the sender through Spout's registry and reads the
     engine's pixels), `arrangement-displays` e2e remote (all 8), the real provider in the desktop session (screens
     report; a Spout display at 59 fps, read back by a separate receiver), and ON SCREEN, checked
     by screenshots of the Ally's desktop: a rehearsal window where it was asked, in front,
     unfocused; fullscreen Fit (a square show pillarboxed) and Stretch over the taskbar, the
     orange top-left quadrant the right way up; identify; Ctrl+Shift+D clearing it all. (A test
     injecting that chord must run elevated when an elevated window has focus: UIPI drops the
     input silently.)
7. **Flip the default:** `arrangementEngine()` in `electron/main.cjs` → native on win32 too, once
   steps 1–5 hold (they do as of 2026-09-30, in the test harness). The packaged Windows app now
   carries `nano_compositor.exe` (`build/bin-win` → `nano/bin`) and has run with
   `NANO_ARRANGEMENT_ENGINE=native` on the Ally: the compositor starts and previews arrive as
   surfaces. Nobody has worked a real show in it yet. Step 4, general formats, was the gate.

---

### M5 — remote deployments

The same `nano_compositor` binary on another machine, driven by an editor elsewhere.

- **Auth first.** `ws_server.cpp` binds 0.0.0.0 unauthenticated. Proposal: bind loopback by default,
  with an explicit "allow remote" setting that requires a pairing token (shown on the compositor
  machine, entered once in the editor, stored per host).
- **Discovery:** Bonjour/mDNS `_nano-comp._tcp` with key, version and name TXT records.
- **Version handshake:** the `ready` line and the first reply carry a protocol version, and the
  editor refuses a mismatch with a readable message. Per the no-back-compat rule, no shims — just a
  clear refusal.
- **Document ownership.** Today `comp_reset` gives each editor session a fresh engine, and the
  editor replays its state. A deployment must keep playing after the editor disconnects:
  - the compositor persists the last document + transport;
  - it keeps running;
  - an editor that connects *attaches* (reads the document back) rather than resetting, unless it
    explicitly takes over.

  That flips the current assumption, so it's the biggest design piece of M5.
- **Media and bundle sync, content-addressed.** The document references media by hash, and the
  compositor fetches misses from the editor over HTTP. `media_fetch.mm` already downloads URLs into
  a per-process cache; make that cache hash-keyed and persistent. Bundles work the same way,
  verified before load.
- **Remote previews** can't use shared surfaces. Use the lanes, compressed (JPEG to start; an H.264
  stream later, which M2's encoder makes cheap on macOS), at a capped rate.

---

### Later — Linux / Raspberry Pi

A Dawn (WebGPU-native) backend spike behind `GPUBackend`. Before committing to it, check on V3D:
- adapter limits;
- BCn support (DXV is BC1: without it, a CPU BC1 decode, or transcode to something else);
- frame time at LED-wall sizes, which is the likely Pi use;
- lavapipe as a CI fallback.

Media would be FFmpeg or GStreamer behind the FrameSource seam, which is exactly what the seam is
for.

---

## Decisions (2026-09-28) and what's still to come

1. **Output config:** outputs are **devices** (displays, lights), defined in a library and added to
   or removed from a composition. The definition holds the per-machine facts; the placement holds the
   per-show facts.
   - Devices come from **visual templates** (a bar looks like a bar, a monitor like a monitor),
     instantiated into exact devices.
   - Displays are generic slots (Display 1 / 2, Syphon), with an **auto** resolution.
   - **No per-output sketch for now.**
   - Where placements live in the UI is still open (M3 § devices).
2. **Precise with an output enabled:** flash the Live button. Don't auto-switch, and don't show a
   dialog.
3. **NDI:** not now.
4. **Art-Net pixel maps:** a new model, part of a light device's definition. It is not the lights
   bundle's model. The user will give more detail.
5. **MIDI into the arrangement:** part of the same devices push. Wait for that design rather than
   inventing an authoring surface.
6. **Windows:** general video formats are required. DXV-only is a test checkpoint, not a milestone.
7. **The arrangement's direction**, which shapes the comp executor:
   - **Composition I/O mode + clipless layers: SHIPPED (2026-09-28)** — see CLAUDE.md and the
     arrangement PRD ("Innovation 3"). Per-track ports are routed with wires, can reach texture fields
     in clip / track / group / main-bus sketches, and have a "send nowhere" output that still
     renders.
   - **Session mode**: an Ableton-style clip grid (next).

   For I/O mode, device ports are just another endpoint (M3 § devices).
