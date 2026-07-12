/*
 * motion.frame_delay — Frame Delay.
 *
 * A video delay line: holds the last N frames of the chain image and outputs the
 * one from `delay` frames ago. Counted in FRAMES, not seconds, and with no
 * interpolation — the output is a bit-exact copy of a frame that really went
 * through, so it stays crisp and predictable regardless of what the host's frame
 * rate is doing. Wire a modulation source into `delay` and it becomes a scrub
 * head over the recent past.
 *
 * The history is age-ordered: hist[0] is this frame, hist[k] is k frames old.
 * Each frame the array rotates by one and the slot that falls off the end is
 * recycled as the new head — so no GPU allocation happens in the steady state,
 * and no modulo bookkeeping is needed when the capacity changes.
 *
 * MEMORY is the whole design constraint here. A frame at 1920x1080 RGBA8 is ~8MB,
 * so the 30-frame maximum is ~250MB — far too much to hold speculatively. The
 * ring therefore tracks the delay you're actually using:
 *   - GROW is immediate (you asked for more history; allocate it now). New slots
 *     append at the OLD end, which is exactly where the not-yet-filled frames
 *     belong, so growing never disturbs the history already captured.
 *   - SHRINK is held off for kShrinkHoldFrames. A `delay` swept by modulation
 *     would otherwise free and reallocate the tail every single frame; the hold
 *     means we only give memory back once the smaller delay has actually settled.
 *   - A viewport resize drops the whole ring (the old frames are the wrong size),
 *   - and on_active(0) — the host bypassing the effect — drops it too, rather
 *     than sitting on a quarter-gigabyte of frames nobody is looking at.
 * While the ring is still filling (or after any of the above), the effect passes
 * the input straight through instead of showing black.
 *
 * NOT identity-skippable and not TimeIndependent, even at delay 0: this effect
 * carries per-frame state, and a skipped frame is a frame that never entered the
 * history — the delay line would silently desync.
 */

#include <gpu.h>
#include <host.h>

namespace video_delay {

// The user-facing cap. 31 slots: `delay` frames of history plus the current one.
static constexpr int kMaxDelay = 30;
static constexpr int kMaxSlots = kMaxDelay + 1;

// How long a smaller delay must hold before we hand the tail textures back.
// ~2s at 60fps — long enough that a modulated delay sweeping up and down never
// thrashes the allocator, short enough that dialing the knob down and leaving it
// there actually releases the memory.
static constexpr int kShrinkHoldFrames = 120;

// Per-instance state. One per chain entry.
struct State {
  int  delay = 0;                  // requested delay, 0..kMaxDelay

  gpu::Texture hist[kMaxSlots];    // age-ordered: hist[0] = this frame
  int  cap = 0;                    // slots currently allocated
  int  filled = 0;                 // slots holding a real frame (<= cap)
  int  tex_w = 0, tex_h = 0;       // size the ring was allocated at
  int  shrink_hold = 0;            // frames the delay has wanted a smaller cap

  bool initialized = false;
};

// Give every frame back. Called on resize, on bypass, and on destroy.
static void releaseRing(State* s) {
  for (int i = 0; i < s->cap; i++) {
    if (s->hist[i].valid()) s->hist[i].release();
    s->hist[i] = gpu::Texture{};
  }
  s->cap = 0;
  s->filled = 0;
  s->shrink_hold = 0;
}

// Bring the ring to `want` slots at the current viewport size, growing at the OLD
// end (so captured history keeps its age) and shrinking from it. Returns false if
// an allocation failed — the caller then falls back to passthrough.
static bool resizeRing(State* s, int want, int w, int h) {
  if (s->cap > 0 && (s->tex_w != w || s->tex_h != h)) {
    releaseRing(s);  // stale size: every held frame is the wrong shape
  }
  s->tex_w = w;
  s->tex_h = h;

  for (int i = want; i < s->cap; i++) {   // shrink: drop the oldest
    if (s->hist[i].valid()) s->hist[i].release();
    s->hist[i] = gpu::Texture{};
  }
  for (int i = s->cap; i < want; i++) {   // grow: append unfilled old slots
    s->hist[i] = gpu::Device::createTexture(w, h);
    if (!s->hist[i].valid()) {
      s->cap = i;
      s->filled = s->filled < s->cap ? s->filled : s->cap;
      return false;
    }
  }

  s->cap = want;
  if (s->filled > s->cap) s->filled = s->cap;
  return true;
}

// Type-level setup: schema only — the effect uses the device copy path, not a
// compute dispatch, so there is no shader or PSO.
void module_init() {
  state::init("motion.frame_delay", {1, 0, 0},
    state::Schema()
      .helpField("intro",
        "## Frame Delay\n"
        "Plays the chain image back **late**, by a whole number of frames. No "
        "interpolation and no time-stretching — the output is exactly a frame that "
        "already went past, so it stays sharp.\n\n"
        "**Try:** wire an LFO into *Delay* to scrub back and forth through the last "
        "half-second, or blend a delayed copy over the live one for a hard echo.\n\n"
        "*Delay* is capped at 30 frames because the history is real video: at 1080p "
        "the full 30 costs a few hundred MB. The effect only holds as many frames as "
        "the delay you're actually using, and passes the image straight through while "
        "the buffer is still filling.")
      .group("delay", "Delay")
      // Frames of history to look back. 0 = the live frame (still fills the ring).
      // A float field (with step 1, and floored on arrival) rather than an int:
      // wire destinations are floats, and being able to modulate the delay is the
      // whole point of the effect.
      .floatField("delay", 0.0f, 0.0f, (float)kMaxDelay, state::PrimaryInput,
                  /*magnitude=*/nullptr, /*step=*/1.0f, /*units=*/"frames")
      .label("Delay", "Frames")
      .textureField("tex_in", state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
  );
}

void* create() {
  return new State();
}

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  releaseRing(s);
  delete s;
}

void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  releaseRing(s);        // re-init on a live instance must not leak the old ring
  s->delay = 0;
  s->tex_w = 0;
  s->tex_h = 0;
  s->initialized = true;
}

// The host bypassed (or un-bypassed) the device. While off we get no tick/render
// at all, so a full ring would just sit there holding hundreds of MB — drop it and
// re-prime on the way back in.
void on_active(void* self, int32_t active) {
  auto* s = static_cast<State*>(self);
  if (!s || active) return;
  releaseRing(s);
}

void tick(void* self, double dt) {
  (void)self;
  (void)dt;
}

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    if (state::pathIs(pb + off[i], len[i], "delay")) {
      // Floor to a whole frame — no interpolation, by design. A modulated delay
      // lands on discrete frames rather than cross-fading between them.
      int d = (int)(state::patchFloat(i) + 0.5f);
      s->delay = d < 0 ? 0 : (d > kMaxDelay ? kMaxDelay : d);
    }
  }
}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;

  auto in  = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!in.valid() || !out.valid()) return;

  const int want = s->delay + 1;   // the delayed frame plus the one we capture now

  // Grow now; shrink only once the smaller delay has settled (see kShrinkHoldFrames).
  if (want > s->cap || s->tex_w != vp_w || s->tex_h != vp_h) {
    s->shrink_hold = 0;
    if (!resizeRing(s, want, vp_w, vp_h)) {
      gpu::Device::copy(in, out);   // out of memory: stay transparent, just pass through
      gpu::Device::submit();
      return;
    }
  } else if (want < s->cap) {
    if (++s->shrink_hold >= kShrinkHoldFrames) {
      resizeRing(s, want, vp_w, vp_h);
      s->shrink_hold = 0;
    }
  } else {
    s->shrink_hold = 0;
  }
  if (s->cap <= 0) return;

  // Rotate: the oldest slot falls off the end and is recycled as the new head.
  gpu::Texture recycled = s->hist[s->cap - 1];
  for (int i = s->cap - 1; i > 0; i--) s->hist[i] = s->hist[i - 1];
  s->hist[0] = recycled;

  gpu::Device::copy(in, s->hist[0]);
  if (s->filled < s->cap) s->filled++;

  // hist[delay] only holds a real frame once we've captured that many. Until then
  // (a fresh drop, a resize, a bypass) pass the live image through — a black hole
  // for half a second reads as a bug.
  const bool have_history = s->delay < s->filled;
  gpu::Device::copy(have_history ? s->hist[s->delay] : in, out);
  gpu::Device::submit();
}

} // namespace video_delay
