#pragma once
/*
 * sidechannel_bus.h — process-global named texture channels BETWEEN executors.
 *
 * "Sidechannels" pass a GPU texture from one barrel instance (or playground
 * sketch) to another through a user-remembered channel name, with no declared
 * wiring — the shared-server counterpart of a patch cable left dangling
 * between racks. A `util.sidechannel_out` stage publishes its input texture
 * onto a channel; a `util.sidechannel_in` stage in ANY executor replaces its
 * chain with that texture — or goes transparent black when the channel is
 * stale (see freshness rule below).
 *
 * SCALAR channels (`util.sidechannel_scalar_out` / `_in`) are the same idea for
 * a modulation value: one float per channel instead of a texture. They live in
 * their OWN namespace — scalar channel "1" and texture channel "1" are
 * unrelated — but share this file's render-seq clock, freshness rule, and
 * metadata version. A stale scalar channel reads 0.0, the same "unplugged cable
 * carries no signal" contract as the texture side's transparent black. Booleans
 * need no special handling: the wire layer already carries them as 0.0/1.0.
 *
 * The bus lives in PROCESS GLOBALS of the
 * shared executor code, which is exactly the sharing domain on both platforms:
 *   - native: every barrel instance's SketchExecutor lives in the one
 *     bridge-server dylib and renders through the one shared GPUBackend
 *     (serialized under BarrelRuntime's render_mu);
 *   - web: every sketch slot's executor lives inside the one executor.wasm
 *     memory and resolves handles against the one shared GPUHost.
 * So one implementation covers both — a texture handle published by executor
 * A is directly bindable by executor B.
 *
 * The bus OWNS its channel textures: a writer's input is copied into a
 * bus-owned persistent texture (executor intermediates rotate per frame and
 * native interop textures are released after each render, so holding the
 * source handle would dangle). Same-format copy; recreated on size/format
 * change.
 *
 * FRESHNESS ("written within 1 frame", accounting for reader-vs-writer
 * order): one process-global monotonic renderSeq increments per
 * SketchExecutor::execute(). A channel entry records the seq current when its
 * writer published (writeSeq); each reader records the seq current at its own
 * PREVIOUS evaluation (prevSeq). Fresh ⇔ writeSeq >= prevSeq — i.e. the
 * channel was written since (or during) the reader's previous render:
 *   - writer earlier in the frame order: same-frame content;
 *   - writer later in the frame order: exactly 1 frame of latency;
 *   - writer below the reader in the SAME sketch: the previous frame's write
 *     carries writeSeq == prevSeq, hence >= (not >) — 1-frame feedback stays
 *     fresh;
 *   - writer deleted/bypassed/stopped: at most one held frame, then stale.
 *
 * Locking: one leaf mutex (native only — the wasm build is single-threaded)
 * held across the whole publish/acquire INCLUDING the gpu_* calls; the GPU
 * layer never re-enters the bus or takes bridge locks, so no ordering cycle
 * is possible. Never touch BridgeServer/tick_mutex_ from in here.
 */

#include <cstdint>

namespace sidechannel_bus {

// Module types the executor host-services (see sketch_executor.cpp).
inline constexpr const char* kOutModuleType = "util.sidechannel_out";
inline constexpr const char* kInModuleType  = "util.sidechannel_in";
inline constexpr const char* kScalarOutModuleType = "util.sidechannel_scalar_out";
inline constexpr const char* kScalarInModuleType  = "util.sidechannel_scalar_in";

/** Advance + return the global render sequence. Called exactly once at the
 *  top of every SketchExecutor::execute(). */
uint64_t beginRender();

/**
 * Publish `srcTex` (w×h) onto `channel`: copy into the bus-owned channel
 * texture (created/recreated to match size + format) and stamp the current
 * renderSeq + the writer's tag (instance identity, for UI labels). Last
 * writer in a frame wins. No-op on an empty channel name or invalid texture.
 */
void publish(const char* channel, int32_t srcTex, int w, int h,
             const char* writerTag);

struct Read {
  int32_t tex = -1;   // bus-owned texture handle (valid until the next publish)
  int w = 0, h = 0;
  bool fresh = false; // freshness rule above; stale readers should go transparent
};

/**
 * Read `channel` for `readerId` (a per-reader-instance unique string —
 * executor address + instance key) and advance that reader's prevSeq to
 * `currentSeq` (this execute()'s beginRender() value). Returns tex=-1 when
 * the channel has never been written.
 */
Read acquire(const char* channel, const char* readerId, uint64_t currentSeq);

/**
 * Look at `channel`'s current texture WITHOUT reader semantics: no freshness
 * check, no prevSeq update — the last-written content, or tex=-1 when the
 * channel has never been written. For host-side preview/thumbnail capture
 * (the Instances tab's sidechannel cards), never for effect routing — effects
 * must go through acquire() so staleness keeps meaning something.
 */
Read peek(const char* channel);

// ── Scalar channels ──────────────────────────────────────────────────────────
// Same clock, same freshness rule, separate namespace (see the header intro).

/**
 * Publish `value` onto scalar `channel`, stamping the current renderSeq + the
 * writer's tag. Last writer in a frame wins. No-op on an empty channel name.
 */
void publishScalar(const char* channel, float value, const char* writerTag);

struct ScalarRead {
  float value = 0.0f;  // 0 unless `fresh` — a stale channel carries no signal
  bool fresh = false;
};

/**
 * Read scalar `channel` for `readerId` (same per-reader-instance id and prevSeq
 * bookkeeping as acquire() — a given instance reads one bus kind, so the two
 * share the reader table). A channel that is unwritten, unbound, or stale
 * returns {0.0, false}.
 */
ScalarRead acquireScalar(const char* channel, const char* readerId,
                         uint64_t currentSeq);

/** Bumped when channel METADATA changes (new channel — texture or scalar —
 *  writer identity, size/format) — deliberately NOT per write, so hosts can
 *  gate metadata pushes on it without per-frame traffic. */
uint64_t version();

/**
 * Serialize channel metadata as JSON — `{"<channel>": {"writer": tag,
 * "w":, "h":}}` — into `out` (capacity `cap`). Returns the FULL byte length
 * (retry with a bigger buffer if > cap). Pair with version() to push
 * `/global/sidechannels` (native) or the worker `sidechannels` message (web).
 */
int32_t infoJson(char* out, int32_t cap);

/**
 * The same, for SCALAR channels — `{"<channel>": {"writer": tag}}`. A separate
 * document because the namespaces are separate; gated on the same version(), so
 * a host fetches both when it changes. The live VALUE is deliberately absent:
 * it moves every frame while version() only bumps on metadata, so anything
 * shipped here would be arbitrarily stale.
 */
int32_t scalarInfoJson(char* out, int32_t cap);

/** Release bus textures + clear all state (tests only). */
void resetForTest();

}  // namespace sidechannel_bus
