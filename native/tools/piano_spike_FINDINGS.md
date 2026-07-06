# Piano-trigger latency spike — findings

Tooling: `piano_spike.py` (+ `piano_mock_resolume.py`). Test rig: Resolume Arena
**7.23.2**, one layer, `Red`=Normal L1C1, `Blue`=Piano L1C2, empty NanoBarrel as
a layer effect. Measurement ground truth = **subscribe to each clip's `connected`
param by id** over the Resolume WS → push updates in ~ms (vs the ~1 s
full-composition rebroadcast the shared server currently reconciles against).

## Root cause of the "sticky piano trigger"

**A `disconnect` (trigger value:false) that reaches Resolume BEFORE it has
registered the preceding `connect` is dropped, and the clip latches stuck-on.**

- Reproduced 100% by sending connect then disconnect back-to-back ("1 then 0
  immediately") — the exact pattern the looper hit while building it.
- A stuck clip **ignores bare disconnects** — a single disconnect, and even 5×
  rapid disconnects, do not clear it. A fresh **connect re-arms** the transport,
  so a following disconnect releases it. ⇒ **clear a stuck clip with a toggle
  (connect→disconnect)**, not repeated disconnects. (This is effectively what the
  reconcile loop stumbles into, which is why it "seems to solve it.")

## What does NOT fix it

- **A fixed time delay between connect and disconnect.** Still ~20–33% stuck at
  every gap from 0 to 25 ms — Resolume's connect-registration time is variable,
  so a wall-clock gap can't guarantee the connect landed first.

  | gap | 0 | 2 | 6 | 10 | 15 | 25 ms |
  |-----|---|---|---|----|----|-------|
  | stuck | 3/15 | 3/15 | 3/15 | 4/15 | 2/15 | 5/15 |

## The fix (0% stuck, ~11 ms note floor)

**Gate the disconnect on the subscription-confirmed `Connected` state:** send
connect, wait until the `connected` param pushes "Connected" (~5 ms), *then* send
disconnect (~5.5 ms release). Measured **0/30 stuck**, connect ~4.9 ms, release
~5.5 ms, **total minimum reliable note ~11 ms** — vs the 250 ms-debounce
workaround.

### Implemented in `native/src/bridge/clip_launcher.*` (+ bridge_server, cache)

**Done.** The launcher is now a per-clip re-arm state machine driven by
subscription-fed observed state. `bridge_server` subscribes to each launchable
clip's `connected` param by id (`connected_observed_`); `composition_cache`
carries `trigger_style` + an `evict_path` (an empty clip on the layer). The fake
Resolume server (`tests/fake_resolume_server`) MODELS the quirks (piano stuck-on,
Normal connect:false no-op + eviction stuck-off, re-arm recovery), and
`test_clip_launcher{,_e2e}.cpp` assert the reconciler converges for: piano
connect/disconnect, piano stuck-on recovery, normal connect, normal off via
eviction, and normal stuck-off recovery. The design below is what shipped:

1. Subscribe each launchable clip's `connected` param by id (push feedback;
   `bridge_server.cpp` already has the plumbing to `subscribe`/route
   `parameter_update`). This is the same lever that makes the whole spike
   ~ms-accurate.
2. On note-ON: send connect.
3. On note-OFF: send disconnect **only once the clip is confirmed Connected**. If
   the OFF arrives before the connect registers, **defer** the disconnect until
   the connected-push arrives, then send it. This is what guarantees no dropped
   disconnect → no stuck.
4. Belt-and-suspenders: if a clip is ever observed Connected while desired Off and
   a disconnect doesn't clear within a short window, issue a **toggle**.

Net: crisp staccato down to ~11 ms notes with 0% stuck, an order of magnitude
below the current 250 ms floor.

## Normal-trigger clips (Red) — quirks + reconciler implications

Tested "Red" (Normal / "Composition Determined") for the same class of issues:

- **`connect:false` is a NO-OP on a Normal clip** (0/12 disconnected) — a Normal
  clip stays on by design. It disconnects only by **eviction** (connecting
  another clip on the same layer) or a layer clear. So a reconciler that turns
  clips off with `connect:false` will loop forever on a Normal clip
  (desired=off, observed=on, never converges).
- **Eviction is consistent**: connecting Blue while Red is on drops Red in
  ~0.5 ms (0/12 inconsistent); firing Red+Blue simultaneously always leaves
  exactly one connected (0/10 both-or-neither). Resolume's own mutual-exclusion
  is reliable — the divergence risk is entirely the dropped-edge latches below.
- **Symmetric latch (stuck-OFF)**: after an eviction/clear, a plain
  `connect:true` on Red can be **dropped** — the clip won't connect. Clearing it
  requires **re-arming with the opposite edge first** (`connect:false`, then
  `connect:true`). This is the mirror image of the piano stuck-**on** bug, which
  needs a connect (re-arm) before the disconnect takes.
- **`/composition/layers/N/clear` triggered over WS is HARMFUL** — it wedged
  Red's connectability specifically (Red couldn't connect for many seconds;
  Blue was unaffected). Do **not** use it as the disconnect verb. The safe,
  style-independent "turn the track off" is **eviction: connect a designated
  empty clip on the layer** (a plain `connect` action, which is reliable).

### Unifying model (drives the reconciler design)

Resolume drops a trigger edge whose target matches its (possibly stale) internal
latched state, leaving the observed connected-state diverged from our desired
state — and **re-sending the same edge does not fix it**. This is one bug with
two faces: stuck-**on** (dropped disconnect) and stuck-**off** (dropped connect).
The universal remedy is **re-arm**: send the opposite edge, then the desired
edge, each gated on the subscription-confirmed state.

Reconciler rules:
1. Subscribe every managed clip's `connected` param (push feedback).
2. **Connect**: send connect; if not confirmed Connected within a short window,
   re-arm (`false` then `true`) and retry.
3. **Disconnect a Piano clip**: send disconnect, but only once Connected is
   confirmed (defer if the OFF beat the connect); if it doesn't clear, re-arm
   with a connect then disconnect.
4. **Disconnect a Normal clip**: `connect:false` won't work — **evict** by
   connecting the layer's empty clip.
5. Treat the subscription as truth; on any observed≠desired that a same-edge
   retry doesn't fix, re-arm. Never `/clear` a track.

## Caveats

- The bug may be partly mitigated in newer Resolume, but is NOT gone (repro is
  still 100% on 7.23.2 for the back-to-back pattern).
- The barrel **thumbnail** channel (visual ground truth) is currently shipping
  zero preview frames despite correct observe + `/preview_requests` + all 8 lanes
  connected — a separate barrel-capture follow-up. The `connected`-param
  subscription was sufficient for every measurement here.
