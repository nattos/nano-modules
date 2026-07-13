# Barrel sketch sync — plan to stop "patching the world"

**Status**: planned, not started (2026-07). Prompted by the `control.barrel_macros`
edit-loss bug (fixed — see *What we already fixed*), which was a symptom, not the disease.

## The principle

**A full sketch sync is a recovery mechanism, not a data path.**

Today the editor reacts to *its own* echoed edit by refetching the entire sketch and
wholesale-replacing local state. That is the "patch the world" reflex, and it is on the
hot path — it runs on every single edit. It should run in exactly four situations:

1. **Initial wire-up** of an instance (`wireInstance`).
2. **Switching** to a different barrel instance.
3. **Reconnect** after the WS drops.
4. **Detected divergence** — we received an op we cannot apply, or a revision gap.

In steady state, a remote change should arrive as an *op* and be applied as an *op*.
Nothing else should ever replace the local sketch.

## Why this matters (the failure we actually shipped)

The `barrel_macros` bug needed *two* faults to bite. We fixed the trigger; the loaded gun
is still on the table.

**The trigger (fixed):** `defaultStateForPlugin` was non-idempotent for an all-help+output
schema, so every mirror-in produced a seed+prune pair of no-op mutations.

**The gun (open):** those no-op mutations were enough to drive a self-sustaining
push → echo → refetch → replace loop at ~140 pushes/sec and ~70 whole-sketch replaces/sec
*with the editor idle*. Each replace overwrote the local sketch with a snapshot requested
**before** the user's edit landed, so edits survived only by chance.

Any future non-idempotent mutation — or a genuinely concurrent remote write — re-arms
exactly this. The loop is a property of the sync design, not of `barrel_macros`.

## The four defects

### 1. The client refetches on its own echo
`boot-resolume.ts:1015` — any op under `/plugins/<key>/state/sketch` sets `sketchTouched`.
`boot-resolume.ts:1038` — `if (sketchTouched && sketchPath) barrel.get(sketchPath);`

The server broadcasts a client's patch back to that same client. We have no notion of
*origin*, so the editor treats its own edit as remote news and refetches. Every edit costs
a round-trip and a full replace, for zero information gain.

### 2. A remote op triggers a whole-sketch refetch, not an op apply
Even for a genuinely remote change, we throw the op away and `get` the entire document.
The op already contains the change; the refetch is pure loss (latency + a replace window).

### 3. The replace clobbers in-flight local edits, and silences them
`setBarrelSketch` (`controller.ts:2547`) assigns
`appState.database.sketches[id] = sketch` wholesale, then reseeds `lastPushedBarrelJson`
(`controller.ts:2552`). So a snapshot that predates a local edit both **discards** the edit
and **marks it as already pushed** — it is never re-sent. Silent data loss, no conflict, no
warning.

The replace is also **lossy**: every adopted snapshot passes through `coerceSketch`
(`boot-resolume.ts`), which rebuilds the sketch from a field whitelist. Any `Sketch` field
missing from that whitelist is stripped by the echo of the client's own push — the barrel
keeps the value (it stores the doc opaquely) while the UI snaps back to the default, and
the "reset to default" edit then produces zero immer patches so nothing is ever pushed to
clear it. This bit `outputFormat` (the resolution-scale buttons, fixed 2026-07 by adding
it to the whitelist); the durable fix is inverting `coerceSketch` to spread-everything +
validate-structural-fields, still queued.

### 4. UI-only metadata rides the wire and defeats the push dedup
`postRecordHook` (`controller.ts:~228-236`) stamps `sketch.lastModified = Date.now()` on
every committed mutation. `maybePushBarrelSketch` (`controller.ts:2705`) dedups on
`JSON.stringify(slimSketchForBarrel(...))` (`controller.ts:2714-2718`), and
`slimSketchForBarrel` (`controller.ts:1631`) strips only help fields — `lastModified`
survives.

So **a mutation that changes nothing still pushes**, because the timestamp moved. The
barrel never reads `lastModified`; it is editor reconcile metadata that should never have
left the editor.

## The plan

Ordered so each step is independently shippable and each one alone would have prevented the
outage. Steps 1-2 are cheap and pure wins; 3-4 are the real design change.

### Step 1 — Keep UI-only metadata off the wire
Strip `lastModified` (and any future editor-only bookkeeping) in `slimSketchForBarrel`, so
it is absent from both the pushed payload and the dedup key.

*Effect:* a no-op mutation produces a byte-identical payload → dedup catches it → no push.
Kills loops at the source even when a mutation is accidentally non-idempotent.

*Care:* `setBarrelSketch`'s reseed at `controller.ts:2552` uses raw `JSON.stringify(sketch)`
while `maybePushBarrelSketch` uses the **slimmed** form. These two must produce the same
string or the dedup misses on the very first post-snapshot mutation. Route both through one
`barrelWireForm(sketch)` helper — the mismatch is latent today.

### Step 2 — Suppress the self-echo
Give each WS client an id. The server tags each broadcast op with the `origin` client id
that caused it (`BridgeCore::handle_message`'s `patch` branch already knows the sender).
Client ignores ops whose `origin` is itself.

*Effect:* an edit no longer triggers a refetch+replace. The steady-state cost of an edit
drops to one outbound patch. This alone makes the loop impossible to sustain.

*Alternative if touching the protocol is unattractive:* track outstanding pushes client-side
and drop an incoming op whose value equals `lastPushedBarrelJson`. Cheaper, but fragile —
it can't distinguish "my echo" from "someone else made the identical edit", and it breaks
the moment two editors are open. Prefer the explicit `origin` tag.

### Step 3 — Apply remote ops incrementally
Replace the `sketchTouched → barrel.get()` reflex with a real op applier: for ops under
`/state/sketch`, apply the RFC-6902 op to the local sketch through a normal `mutate(...)`
so undo/history stay coherent.

Fall back to a full `get` **only** when the op cannot be applied cleanly (missing path,
type mismatch) — i.e. we have detected divergence, which is precisely case (4) in *The
principle*.

*Effect:* a remote change costs one op, not a document. No replace window, so no clobber.

### Step 4 — Revision numbers + explicit divergence detection
`StateDocument` gains a monotonic `rev` per document, carried on every broadcast op and
returned with every snapshot. The client tracks the last applied `rev`.

- Op with `rev == last + 1` → apply (Step 3).
- Op with `rev > last + 1` → **we missed something** → full resync (legitimate case 4).
- Snapshot with `rev < last` → stale, discard (this is the exact race that ate edits).

*Effect:* full sync becomes a rare, *deliberate*, observable recovery path instead of an
implicit per-edit reflex. A stale snapshot can no longer overwrite newer local state,
because we can finally *tell* that it is stale — today we cannot, which is the root reason
Step 3's replace was unsafe.

### Step 5 — Make regressions loud
- Unit test: `defaultStateForPlugin` is idempotent and never returns a `type:'help'` key.
  (Partly done — the `barrel_macros` shape is covered in `output-field-seeding.test.ts`.)
- Unit test: a mirror-in of an unchanged sketch produces **zero** pushes.
- Dev-mode **loop canary**: warn if outbound sketch pushes exceed N/sec. The outage ran at
  ~140/sec for who knows how long and nothing said a word. A one-line counter would have
  caught it the day it landed.

## What we already fixed

- **`outputFormat` survives the echo** (shipped 2026-07): `coerceSketch`'s field whitelist
  dropped `outputFormat`, so the echo replace snapped the resolution-scale UI back to 1×
  while the barrel kept rendering at the pushed scale (see defect 3's *lossy* note). Fixed
  by carrying the key through (`normalizeSketchChains` sanitizes it). The whitelist itself
  is still a standing hazard for every future `Sketch` field — inverting it to
  spread-everything + validate-structural-fields is the class-level fix, not yet done.
- **Idempotent defaults** (shipped): `defaultStateForPlugin`'s legacy `params` fallback loop
  now applies the help-field skip as well as the output skip, so an all-help+output effect
  (`control.barrel_macros`) defaults to `{}` and the seed/prune churn never fires.
  Regression test in `src/state/output-field-seeding.test.ts`.

This removed the trigger. **It did not remove the loop.** Steps 1-4 above are what actually
make the sync safe.
