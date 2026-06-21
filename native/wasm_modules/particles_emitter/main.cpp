/*
 * particles_emitter — produces a stream of 2D particles whose positions
 * and velocities live in GPU storage buffers exposed via a struct rail.
 *
 * Schema:
 *   spawn_speed : float   — per-frame velocity magnitude for newly spawned particles
 *   gravity     : float2  — applied each frame to velocity
 *   particles_out : object (Output, Primary)
 *     count      : int            (current particle count)
 *     positions  : array<float> (gpu)  — interleaved x,y per particle
 *     velocities : array<float> (gpu)  — interleaved vx,vy per particle
 *
 * Physics runs on the CPU each tick(). render() uploads the latest data
 * via Buffer::writeBytes and calls state::markGpuDirty() so downstream
 * readers can react.
 *
 * Class-like instance model: module_init() publishes the schema once per
 * type; each chain entry gets its own State (params, CPU particle arrays,
 * accumulators, and its own pair of GPU storage buffers) via create().
 * Each instance publishes ITS OWN buffer handles onto its output rail.
 * All instance callbacks take `self`.
 */

#include <gpu.h>
#include <host.h>
#include <cmath>
#include <cstdint>

namespace particles_emitter {

static constexpr int PARTICLE_COUNT = 256;
static constexpr int FLOATS_PER_PARTICLE = 2; // x, y (and vx, vy in velocities)

// Per-instance state. One per chain entry.
struct State {
  gpu::Buffer s_positions;
  gpu::Buffer s_velocities;
  float s_pos[PARTICLE_COUNT * FLOATS_PER_PARTICLE];
  float s_vel[PARTICLE_COUNT * FLOATS_PER_PARTICLE];
  float s_gravity_x = 0.0f;
  float s_gravity_y = -0.4f;
  float s_spawn_speed = 0.6f;
  double s_time_accum = 0.0;
  bool s_initialized = false;
};

// Cheap deterministic hash for varied initial conditions without <random>.
// Pure — no instance state.
static float hash01(uint32_t i) {
  i = (i ^ 61u) ^ (i >> 16);
  i = i + (i << 3);
  i = i ^ (i >> 4);
  i = i * 0x27d4eb2du;
  i = i ^ (i >> 15);
  return (i & 0xFFFFFF) / float(0x1000000);
}

// Touches instance particle arrays + spawn speed → takes State&.
static void respawn(State& s, int idx, double t) {
  // Spawn from the bottom edge with an upward velocity in a fan shape.
  uint32_t seed = uint32_t(idx) * 2654435761u + uint32_t(t * 1000.0);
  float u = hash01(seed);
  float v = hash01(seed ^ 0x9E3779B9u);
  s.s_pos[idx * 2 + 0] = (u * 2.0f - 1.0f) * 0.6f;
  s.s_pos[idx * 2 + 1] = -1.0f;
  float angle = (v - 0.5f) * 1.5f; // ~±0.75 rad fan
  s.s_vel[idx * 2 + 0] = std::sin(angle) * s.s_spawn_speed;
  s.s_vel[idx * 2 + 1] = std::cos(angle) * s.s_spawn_speed * 1.5f;
}

// Type-level setup: publish the schema + backend check. Runs once per type.
void module_init() {
  state::init("debug.particles_emitter", {1, 0, 0},
    state::Schema()
      .floatField("spawn_speed", 0.6f, 0.f, 2.f, state::PrimaryInput)
      .vec2Field("gravity", 0.0f, -0.4f, state::PrimaryInput, -1.f, 1.f)
      .beginObject("particles_out", state::PrimaryOutput)
        .intField("count", PARTICLE_COUNT, 0, PARTICLE_COUNT, state::None)
        .gpuArrayField("positions", "float", state::None)
        .gpuArrayField("velocities", "float", state::None)
      .endObject()
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::log("particles_emitter: module initialized");
}

// Per-instance construction: allocate State + its own GPU storage buffers,
// and publish THIS instance's buffer handles onto its output rail.
void* create() {
  auto* s = new State();

  // Allocate this instance's persistent GPU buffers.
  const int byte_count = PARTICLE_COUNT * FLOATS_PER_PARTICLE * (int)sizeof(float);
  s->s_positions  = gpu::Device::createBuffer(byte_count, gpu::BufferUsage::Storage);
  s->s_velocities = gpu::Device::createBuffer(byte_count, gpu::BufferUsage::Storage);

  // Publish this instance's buffer handles once, mirroring where the
  // original published them (right after allocation).
  state::setGpuBuffer("particles_out/positions",  s->s_positions.id);
  state::setGpuBuffer("particles_out/velocities", s->s_velocities.id);

  return s;
}

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->s_positions.release();
  s->s_velocities.release();
  delete s;
}

// Per-instance init tail: seed initial particle state + mark ready.
void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->s_initialized = false;

  // Seed initial state.
  for (int i = 0; i < PARTICLE_COUNT; i++) respawn(*s, i, 0.0);

  s->s_initialized = true;
  state::log("particles_emitter: initialized");
}

void tick(void* self, double dt) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  if (!s->s_initialized) return;
  s->s_time_accum += dt;
  const float fdt = float(dt);

  for (int i = 0; i < PARTICLE_COUNT; i++) {
    s->s_vel[i * 2 + 0] += s->s_gravity_x * fdt;
    s->s_vel[i * 2 + 1] += s->s_gravity_y * fdt;
    s->s_pos[i * 2 + 0] += s->s_vel[i * 2 + 0] * fdt;
    s->s_pos[i * 2 + 1] += s->s_vel[i * 2 + 1] * fdt;

    // Respawn when off-screen.
    if (s->s_pos[i * 2 + 1] < -1.2f
        || std::fabs(s->s_pos[i * 2 + 0]) > 1.5f) {
      respawn(*s, i, s->s_time_accum + i * 0.013);
    }
  }
}

void on_resolume_param(void*, long long, double) {}

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  (void)ops;
  for (int i = 0; i < n; i++) {
    const char* path = pb + off[i];
    int plen = len[i];
    if (state::pathIs(path, plen, "spawn_speed")) {
      s->s_spawn_speed = state::patchFloat(i);
    }
    // gravity (vec2) arrives as an array value — read via val::getIndex.
    else if (state::pathIs(path, plen, "gravity")) {
      auto patch = val::Value(state::getPatch(i));
      auto v = val::Value(val::get(patch.h, "value"));
      if (val::typeOf(v.h) == val::Array && val::length(v.h) >= 2) {
        auto vx = val::Value(val::getIndex(v.h, 0));
        auto vy = val::Value(val::getIndex(v.h, 1));
        s->s_gravity_x = float(val::asNumber(vx.h));
        s->s_gravity_y = float(val::asNumber(vy.h));
      }
    }
  }
}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  (void)vp_w; (void)vp_h;
  if (!s->s_initialized) return;

  // Push the latest CPU state into the GPU buffers.
  s->s_positions.write(s->s_pos, PARTICLE_COUNT * FLOATS_PER_PARTICLE);
  s->s_velocities.write(s->s_vel, PARTICLE_COUNT * FLOATS_PER_PARTICLE);

  // Buffers are reused frame-over-frame, so no setGpuBuffer call here —
  // just announce the contents are dirty so downstream readers know to
  // rebind / redraw.
  state::markGpuDirty("particles_out");

  gpu::Device::submit();
}

} // namespace particles_emitter
