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
 * readers can react. The buffers themselves are allocated once at init
 * and re-bound to the field via state::setGpuBuffer() at that point.
 */

#include <gpu.h>
#include <host.h>
#include <cmath>
#include <cstdint>

namespace particles_emitter {

static constexpr int PARTICLE_COUNT = 256;
static constexpr int FLOATS_PER_PARTICLE = 2; // x, y (and vx, vy in velocities)

static gpu::Buffer s_positions;
static gpu::Buffer s_velocities;
static float s_pos[PARTICLE_COUNT * FLOATS_PER_PARTICLE];
static float s_vel[PARTICLE_COUNT * FLOATS_PER_PARTICLE];
static float s_gravity_x = 0.0f;
static float s_gravity_y = -0.4f;
static float s_spawn_speed = 0.6f;
static double s_time_accum = 0.0;
static bool s_initialized = false;

// Cheap deterministic hash for varied initial conditions without <random>.
static float hash01(uint32_t i) {
  i = (i ^ 61u) ^ (i >> 16);
  i = i + (i << 3);
  i = i ^ (i >> 4);
  i = i * 0x27d4eb2du;
  i = i ^ (i >> 15);
  return (i & 0xFFFFFF) / float(0x1000000);
}

static void respawn(int idx, double t) {
  // Spawn from the bottom edge with an upward velocity in a fan shape.
  uint32_t seed = uint32_t(idx) * 2654435761u + uint32_t(t * 1000.0);
  float u = hash01(seed);
  float v = hash01(seed ^ 0x9E3779B9u);
  s_pos[idx * 2 + 0] = (u * 2.0f - 1.0f) * 0.6f;
  s_pos[idx * 2 + 1] = -1.0f;
  float angle = (v - 0.5f) * 1.5f; // ~±0.75 rad fan
  s_vel[idx * 2 + 0] = std::sin(angle) * s_spawn_speed;
  s_vel[idx * 2 + 1] = std::cos(angle) * s_spawn_speed * 1.5f;
}

void init() {
  s_initialized = false;

  state::init("data.particles_emitter", {1, 0, 0},
    state::Schema()
      .floatField("spawn_speed", 0.6f, 0.f, 2.f, state::PrimaryInput)
      .vec2Field("gravity", 0.0f, -0.4f, state::PrimaryInput)
      .beginObject("particles_out", state::PrimaryOutput)
        .intField("count", PARTICLE_COUNT, 0, PARTICLE_COUNT, state::None)
        .gpuArrayField("positions", "float", state::None)
        .gpuArrayField("velocities", "float", state::None)
      .endObject()
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  // Allocate persistent GPU buffers and publish their handles once.
  const int byte_count = PARTICLE_COUNT * FLOATS_PER_PARTICLE * (int)sizeof(float);
  s_positions  = gpu::Device::createBuffer(byte_count, gpu::BufferUsage::Storage);
  s_velocities = gpu::Device::createBuffer(byte_count, gpu::BufferUsage::Storage);

  state::setGpuBuffer("particles_out/positions",  s_positions.id);
  state::setGpuBuffer("particles_out/velocities", s_velocities.id);

  // Seed initial state.
  for (int i = 0; i < PARTICLE_COUNT; i++) respawn(i, 0.0);

  s_initialized = true;
  state::log("particles_emitter: initialized");
}

void tick(double dt) {
  if (!s_initialized) return;
  s_time_accum += dt;
  const float fdt = float(dt);

  for (int i = 0; i < PARTICLE_COUNT; i++) {
    s_vel[i * 2 + 0] += s_gravity_x * fdt;
    s_vel[i * 2 + 1] += s_gravity_y * fdt;
    s_pos[i * 2 + 0] += s_vel[i * 2 + 0] * fdt;
    s_pos[i * 2 + 1] += s_vel[i * 2 + 1] * fdt;

    // Respawn when off-screen.
    if (s_pos[i * 2 + 1] < -1.2f
        || std::fabs(s_pos[i * 2 + 0]) > 1.5f) {
      respawn(i, s_time_accum + i * 0.013);
    }
  }
}

void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops) {
  (void)ops;
  for (int i = 0; i < n; i++) {
    const char* path = pb + off[i];
    int plen = len[i];
    if (state::pathIs(path, plen, "spawn_speed")) {
      s_spawn_speed = state::patchFloat(i);
    }
    // gravity (vec2) arrives as an array value — read via val::getIndex.
    else if (state::pathIs(path, plen, "gravity")) {
      auto patch = val::Value(state::getPatch(i));
      auto v = val::Value(val::get(patch.h, "value"));
      if (val::typeOf(v.h) == val::Array && val::length(v.h) >= 2) {
        auto vx = val::Value(val::getIndex(v.h, 0));
        auto vy = val::Value(val::getIndex(v.h, 1));
        s_gravity_x = float(val::asNumber(vx.h));
        s_gravity_y = float(val::asNumber(vy.h));
      }
    }
  }
}

void render(int vp_w, int vp_h) {
  (void)vp_w; (void)vp_h;
  if (!s_initialized) return;

  // Push the latest CPU state into the GPU buffers.
  s_positions.write(s_pos, PARTICLE_COUNT * FLOATS_PER_PARTICLE);
  s_velocities.write(s_vel, PARTICLE_COUNT * FLOATS_PER_PARTICLE);

  // Buffers are reused frame-over-frame, so no setGpuBuffer call here —
  // just announce the contents are dirty so downstream readers know to
  // rebind / redraw.
  state::markGpuDirty("particles_out");

  gpu::Device::submit();
}

} // namespace particles_emitter
