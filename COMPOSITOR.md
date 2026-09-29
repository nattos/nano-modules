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

**Decided (2026-09-29): the model has four layers**, with the same words for every kind:
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
the path texture devices (lights, displays) will need. The order is D2 lights, D3 displays, D4
inputs (Art-Net in, FFT).

#### The present API (`GPUBackend`)

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

#### Threading and pacing: the loop must move

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

#### Syphon

- The Metal backend already renders into IOSurface-backed textures for the preview ring.
  `SyphonMetalServer` (Syphon.framework, BSD) publishes a texture from our `MTLDevice`
  (`nativeDevice()`).
- Link the framework and stage it in the resource root's `bin/` with an rpath, the way the
  compositor binary is staged.
- A Syphon output is a display-like device (a texture input). The server is named by its device
  definition, and one server runs per placed device.
- Publish on the render thread right after the frame's submit.
- Test: a ctest that runs a `SyphonMetalClient` in-process and reads a known colour.

#### Art-Net / DMX output (pixel mapping)

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

The Windows environment is being set up now. `WINDOWS.md` and memory (`project_windows_d3d11_port`)
record what already runs on D3D11:
- the executor, comp render and FFGL plugin build;
- the executor under WAMR, pixel-identical.

The compositor itself doesn't build there yet, for one structural reason: **`nano_media` is
Apple-only, and `comp_host` is gated on it** (`native/CMakeLists.txt`, the `if(TARGET nano_media)`
around `comp_host`).

**Decided: general video formats are required.** A DXV-only compositor is a stepping stone for
running the tests, NOT a milestone to ship. Windows goes native only once Media Foundation decode
works. Order:

1. **Split `nano_media` into a portable core plus a platform layer.**
   - Portable: `dxv_source`, `frame_blitter`, `frame_source` routing, `video_pump`, the DXV demux/LZ.
   - Apple: `avf_source.mm`, `media_fetch.mm`, `video_encoder.mm`.
   - At this step Windows decodes **DXV and stills only**, as an internal checkpoint. `openFrameSource`
     already names each refusal, and a refused clip reports ready and transparent, so H.264 clips
     simply don't show; nothing hangs.
   - Stills via WIC (`IWICBitmapDecoder` → premultiplied → un-premultiply, matching
     `openImageFrameSource`'s straight-alpha output).
   - `media_fetch` via WinHTTP, or refuse URLs on Windows at first: it only matters for dev-server
     test fixtures.
   - This builds `comp_host` + `nano_compositor.exe`.
2. **Run the native legs of the arrangement suites on Windows,** with previews on the **lanes**
   (NBPC). The shared-surface path isn't there yet, and the web side already falls back.
   - `compositor.cjs` already names `nano_compositor.exe`.
   - `test/comp-backend.ts` must spawn the `.exe` from the Windows build dir.
3. **Shared preview surfaces on D3D11.** This also lifts Remote Control off the lanes on Windows.
   - `createSharedSurface`: a BGRA texture with `D3D11_RESOURCE_MISC_SHARED_NTHANDLE |
     D3D11_RESOURCE_MISC_SHARED`, and `IDXGIResource1::CreateSharedHandle` with a **name**
     (`Local\nano_surf_<pid>_<n>`). The token in the NBPS announce identifies the name.
   - The addon's Windows half (`web/native/nano_shared_surface`) calls
     `ID3D11Device1::OpenSharedResourceByName`, or opens it as an NT handle, and gives Electron
     `handle: { ntHandle }`.
   - **Completion:** macOS announces a slot only after the blit completes. On D3D11, issue a
     `D3D11_QUERY_EVENT` after the blit and poll `GetData` before announcing. Never block the render
     thread on it.
   - **Adapter trap:** Electron's GPU process must open the handle on the *same adapter*. On
     hybrid-GPU laptops it may not. Put the adapter LUID in the announce, and have the web side fall
     back to lanes on a mismatch. This is the open "which GPU" question from the port notes.
4. **Media Foundation decode** (`MfVideoSource : FrameSource`).
   - Use `IMFSourceReader` with CPU output (`MFVideoFormat_RGB32` via
     `MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING`), matching AVF's CPU-buffer `prepare()` →
     render-thread `upload()` split.
   - Resist sharing our D3D11 device with MF's DXVA path at first. That needs
     `ID3D10Multithread::SetMultithreadProtected` on a device the engine assumes is single-threaded.
   - Exact-frame seeks use the same logic as AVF: `SetCurrentPosition` lands on a prior keyframe;
     decode forward and drop samples until the timestamp covers the target. Pin it with the same
     `test_h264_ramp.mp4` exactness test (grey `16+3N`).
5. **Media Foundation encode** (`VideoEncoder`'s Windows twin).
   - `IMFSinkWriter` → H.264 in MP4 with `MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS`.
   - Tag `MF_MT_VIDEO_PRIMARIES` / `MF_MT_TRANSFER_FUNCTION` / `MF_MT_YUV_MATRIX` as BT.709. Untagged
     output comes back dull, as it did on macOS.
   - Rational frame rate via `MF_MT_FRAME_RATE`.
   - `test_comp_export` is the contract: red, backdrop gap, green, decoded back.
6. **Outputs on Windows.**
   - A DXGI flip-model present into a borderless HWND per display, identified by the monitor's
     device path, not its index.
   - **Spout** via SpoutDX (BSD), on our D3D11 device.
7. **Flip the default:** `arrangementEngine()` in `electron/main.cjs` → native on win32 too, once
   steps 1–5 hold. Step 4, general formats, is the gate.

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
