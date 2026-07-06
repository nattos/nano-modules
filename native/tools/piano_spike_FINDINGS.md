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

### Recommended change to `native/src/bridge/clip_launcher.*`

Replace "reconcile desired vs ~1 s-stale rebroadcast state, 250 ms debounce" with:

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

## Caveats

- The bug may be partly mitigated in newer Resolume, but is NOT gone (repro is
  still 100% on 7.23.2 for the back-to-back pattern).
- The barrel **thumbnail** channel (visual ground truth) is currently shipping
  zero preview frames despite correct observe + `/preview_requests` + all 8 lanes
  connected — a separate barrel-capture follow-up. The `connected`-param
  subscription was sufficient for every measurement here.
