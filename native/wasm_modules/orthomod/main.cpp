/*
 * gen.orthomod — Hadamard-driven, beat-synced bar pattern.
 *
 * Two co-driven code systems sharing one global envelope:
 *
 *   System A — channel envelopes (4 per-bar brightness rails).
 *     8×8 Hadamard, rows sorted by complexity, columns Fisher-Yates
 *     shuffled by seed. Row 0 forced to all-ones.
 *     idx_A = floor((1 - env) * 8) — env=1 picks row 0 → all channels ON.
 *     Each row's 8 bits split into 4 (bar) × 2-bit waveform codes:
 *       (0,0)=OFF, (1,1)=ON, (1,0)=square @ mod_rate, (0,1)=|sin| @ mod_rate.
 *
 *   System B — bar fill pattern (4 bars × hadamard_size segments).
 *     MxM Hadamard grouped into P = M/4 pages of 4 rows each. Pages
 *     sorted ascending by entropy (sum of within-column row transitions).
 *     Equal-entropy pages shuffled by seed.
 *     page_idx = floor(env * P) — env=1 picks highest-entropy page.
 *     bar c, segment r → bit = page[c][r mod M].
 *
 * Beat sync via fx::BeatTick: integer crossings of effective_beats
 * snap linear_env := 1; decay otherwise. Decay time in beats →
 * seconds via host::bpm().
 *
 * Outputs:
 *   tex_out         — colored bar pattern (off bits / outside inset pass through tex_in)
 *   ch1..ch4, env   — float rails for downstream effects to tap.
 */

#include <gpu.h>
#include <host.h>
#include <val.h>
#include <effect_utils.h>
#include <effect_beat_tick.h>
#include "orthomod_shaders.h"

#include <cmath>
#include <cstdint>
#include <cstring>

namespace orthomod {

static constexpr int  BARS                  = 4;
static constexpr int  SYS_A_N               = 8;     // 8x8 Hadamard
static constexpr int  MAX_HADAMARD          = 64;    // System B cap (powers of 2 only)
static constexpr int  MAX_PAGES             = MAX_HADAMARD / 4;
static constexpr int  MAX_PAGE_BITS         = BARS * MAX_HADAMARD;

struct Uniforms {
  // row 0 — per-bar channel envelopes (already waveform-shaped on CPU)
  float ch0;
  float ch1;
  float ch2;
  float ch3;

  // row 1
  float env;
  float primary_hue;
  float saturation;
  float intensity;

  // row 2
  float scatter_max;
  float channel_brightness_mod;
  float inset_top;
  float inset_bottom;

  // row 3
  uint32_t hadamard_size;
  uint32_t render_bits;
  uint32_t page_idx;
  uint32_t seed;
};
static_assert(sizeof(Uniforms) == 64, "Uniforms layout mismatch");

// --- GPU resources ---
static gpu::ComputePSO s_pso;
static gpu::Buffer     s_uniform_buf;
static gpu::Buffer     s_page_buf;            // 4 × hadamard_size uints
static bool            s_initialized = false;

// --- Schema-mirrored params ---
// Standard
static int   s_beat_multiplier_id   = 2;       // index into the select table
static float s_primary_hue          = 0.08f;
static float s_saturation           = 0.9f;
static float s_intensity            = 1.0f;
static float s_decay_time_beats     = 1.0f;
static float s_decay_curve          = 0.0f;    // signed [-1,+1] via fx::signedSliderToExp
static float s_scatter_max          = 0.15f;
static float s_channel_brightness_mod = 0.5f;
static float s_mod_rate_hz          = 15.0f;
// Tuning
static int   s_hadamard_size        = 32;
static int   s_render_bits          = 13;
static float s_inset_top            = 0.0f;
static float s_inset_bottom         = 0.0f;
static int   s_seed                 = 1;

// Map beat_multiplier_id → ticks per bar. Indices match the selectField
// option ordering (1/4, 1/2, 1, 2, 4).
static inline float beat_multiplier_value(int id) {
  switch (id) {
    case 0: return 0.25f;
    case 1: return 0.5f;
    case 2: return 1.0f;
    case 3: return 2.0f;
    case 4: return 4.0f;
    default: return 1.0f;
  }
}

// --- Runtime state ---
static fx::BeatTick s_tick;
static double s_linear_env = 0.0;
static double s_mod_phase  = 0.0;

// --- Cached System A: rows sorted by complexity, columns shuffled by seed ---
static uint8_t s_sys_a_rows[SYS_A_N][SYS_A_N];   // sorted+shuffled bits, 0/1
static bool    s_sys_a_dirty   = true;
static int     s_sys_a_seed    = -1;

// --- Cached System B: full Hadamard + page ordering ---
static uint8_t s_sys_b_bits[MAX_HADAMARD][MAX_HADAMARD]; // raw, unsorted
static int     s_sys_b_page_order[MAX_PAGES];            // index of each ordered page in the raw matrix
static int     s_sys_b_size_cached = -1;
static int     s_sys_b_seed_cached = -1;

// --- Helpers ---
static inline float clampf(float v, float lo, float hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}
static inline int clampi(int v, int lo, int hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}
static inline uint32_t lcg_next(uint32_t& s) {
  s = s * 1664525u + 1013904223u;
  return s;
}
static inline int round_up_pow2(int v) {
  if (v <= 1) return 1;
  int p = 1;
  while (p < v) p <<= 1;
  return p;
}
static inline int popcount32(uint32_t x) {
  x = x - ((x >> 1) & 0x55555555u);
  x = (x & 0x33333333u) + ((x >> 2) & 0x33333333u);
  x = (x + (x >> 4)) & 0x0F0F0F0Fu;
  return (int)((x * 0x01010101u) >> 24);
}
// 0/1 Hadamard bit at (i, j) for the 2^n × 2^n Sylvester matrix.
// Row 0 = all 1 (popcount(0&j) = 0).
static inline uint8_t hadamard_bit(int i, int j) {
  return (uint8_t)(1 ^ (popcount32((uint32_t)(i & j)) & 1));
}

static int sys_a_row_complexity(const uint8_t* row) {
  int t = 0;
  for (int j = 0; j + 1 < SYS_A_N; j++) if (row[j] != row[j + 1]) t++;
  return t;
}

static int sys_b_page_entropy(int page_first_row, int M) {
  int t = 0;
  for (int c = 0; c < M; c++) {
    for (int r = 0; r < 3; r++) {
      if (s_sys_b_bits[page_first_row + r][c] !=
          s_sys_b_bits[page_first_row + r + 1][c]) t++;
    }
  }
  return t;
}

static void rebuild_sys_a() {
  // 1. Generate raw 8x8 Hadamard.
  uint8_t raw[SYS_A_N][SYS_A_N];
  for (int i = 0; i < SYS_A_N; i++) {
    for (int j = 0; j < SYS_A_N; j++) raw[i][j] = hadamard_bit(i, j);
  }
  // 2. Sort row indices by complexity ascending. Row 0 (all 1s) has 0
  //    transitions, so it lands first naturally. Tie-break by index.
  int row_order[SYS_A_N];
  for (int i = 0; i < SYS_A_N; i++) row_order[i] = i;
  for (int i = 1; i < SYS_A_N; i++) {
    int v = row_order[i], cv = sys_a_row_complexity(raw[v]), j = i - 1;
    while (j >= 0) {
      int cj = sys_a_row_complexity(raw[row_order[j]]);
      if (cj > cv || (cj == cv && row_order[j] > v)) {
        row_order[j + 1] = row_order[j]; j--;
      } else break;
    }
    row_order[j + 1] = v;
  }
  // 3. Fisher-Yates column permutation seeded from user seed.
  int col_perm[SYS_A_N];
  for (int i = 0; i < SYS_A_N; i++) col_perm[i] = i;
  uint32_t rng = (uint32_t)s_seed ^ 0xA1B2C3D4u;
  lcg_next(rng);
  for (int i = SYS_A_N - 1; i > 0; i--) {
    uint32_t r = lcg_next(rng);
    int k = (int)(r % (uint32_t)(i + 1));
    int t = col_perm[i]; col_perm[i] = col_perm[k]; col_perm[k] = t;
  }
  // 4. Assemble sorted + shuffled output.
  for (int i = 0; i < SYS_A_N; i++) {
    for (int j = 0; j < SYS_A_N; j++) {
      s_sys_a_rows[i][j] = raw[row_order[i]][col_perm[j]];
    }
  }
  s_sys_a_seed = s_seed;
  s_sys_a_dirty = false;
}

static void rebuild_sys_b(int M) {
  // Generate raw MxM Hadamard.
  for (int i = 0; i < M; i++) {
    for (int j = 0; j < M; j++) s_sys_b_bits[i][j] = hadamard_bit(i, j);
  }
  int P = M / 4;
  if (P < 1) P = 1;
  // Compute entropy per page, then sort ascending. Stable sort within
  // equal entropy, then break those ties by seed-driven shuffle.
  int entropies[MAX_PAGES];
  int order[MAX_PAGES];
  for (int p = 0; p < P; p++) {
    order[p] = p;
    entropies[p] = sys_b_page_entropy(p * 4, M);
  }
  for (int i = 1; i < P; i++) {
    int v = order[i], ev = entropies[v], j = i - 1;
    while (j >= 0 && entropies[order[j]] > ev) {
      order[j + 1] = order[j]; j--;
    }
    order[j + 1] = v;
  }
  // Seed-driven shuffle within equal-entropy runs.
  uint32_t rng = (uint32_t)s_seed ^ 0xDECAF000u;
  lcg_next(rng);
  int i = 0;
  while (i < P) {
    int j = i + 1;
    while (j < P && entropies[order[j]] == entropies[order[i]]) j++;
    // Fisher-Yates over [i, j).
    for (int k = j - 1; k > i; k--) {
      uint32_t r = lcg_next(rng);
      int q = i + (int)(r % (uint32_t)(k - i + 1));
      int t = order[k]; order[k] = order[q]; order[q] = t;
    }
    i = j;
  }
  for (int p = 0; p < P; p++) s_sys_b_page_order[p] = order[p];
  s_sys_b_size_cached = M;
  s_sys_b_seed_cached = s_seed;
}

static void ensure_caches() {
  // Hadamard sizes constrained to powers of 2 in [4, MAX_HADAMARD].
  int M = round_up_pow2(s_hadamard_size);
  if (M < 4) M = 4;
  if (M > MAX_HADAMARD) M = MAX_HADAMARD;
  if (M != s_hadamard_size) s_hadamard_size = M;

  if (s_sys_a_dirty || s_sys_a_seed != s_seed) rebuild_sys_a();
  if (s_sys_b_size_cached != M || s_sys_b_seed_cached != s_seed) rebuild_sys_b(M);
}

// Sample the per-channel waveform for a 2-bit code.
//   (0,0) → 0     (1,1) → 1
//   (1,0) → square @ mod_phase   (0,1) → |sin(2π mod_phase)|
static float channel_value(int code_msb, int code_lsb, double mod_phase) {
  if (code_msb == 0 && code_lsb == 0) return 0.0f;
  if (code_msb == 1 && code_lsb == 1) return 1.0f;
  if (code_msb == 1 && code_lsb == 0) {
    return (mod_phase - std::floor(mod_phase)) < 0.5 ? 1.0f : 0.0f;
  }
  // (0,1)
  return (float)std::fabs(std::sin(mod_phase * 2.0 * 3.14159265358979));
}

void init() {
  s_initialized = false;
  s_sys_a_dirty = true;
  s_sys_a_seed = -1;
  s_sys_b_size_cached = -1;
  s_sys_b_seed_cached = -1;
  s_linear_env = 0.0;
  s_mod_phase = 0.0;
  s_tick.reset();
  std::memset(s_sys_a_rows, 0, sizeof(s_sys_a_rows));
  std::memset(s_sys_b_bits, 0, sizeof(s_sys_b_bits));

  state::init("gen.orthomod", {1, 0, 0},
    state::Schema()
      // --- Standard ---
      .selectField("beat_multiplier", 2, state::PrimaryInput,
                   {{"1/4", 0}, {"1/2", 1}, {"1", 2}, {"2", 3}, {"4", 4}})
      .floatField("primary_hue",            0.08f, 0.0f, 1.0f,  state::PrimaryInput)
      .floatField("saturation",             0.9f,  0.0f, 1.0f,  state::PrimaryInput)
      .floatField("intensity",              1.0f,  0.0f, 2.0f,  state::PrimaryInput)
      .floatField("decay_time_beats",       1.0f,  0.05f, 4.0f, state::PrimaryInput)
      .floatField("decay_curve",            0.0f, -1.0f, 1.0f,  state::PrimaryInput)
      .floatField("scatter_max",            0.15f, 0.0f, 0.5f,  state::PrimaryInput)
      .floatField("channel_brightness_mod", 0.5f,  0.0f, 1.0f,  state::PrimaryInput)
      .floatField("mod_rate_hz",            15.0f, 0.0f, 30.0f, state::PrimaryInput)
      // --- Tuning ---
      .intField  ("hadamard_size", 32, 4, MAX_HADAMARD, state::PrimaryInput)
      .intField  ("render_bits",   13, 1, 64,           state::PrimaryInput)
      .floatField("inset_top",     0.0f, 0.0f, 0.5f,    state::PrimaryInput)
      .floatField("inset_bottom",  0.0f, 0.0f, 0.5f,    state::PrimaryInput)
      .intField  ("seed",          1, 0, 0x7FFFFFFF,    state::PrimaryInput)
      // --- Output rails (5 separate floats per meta-question #3) ---
      .floatField("ch1", 0.0f, 0.0f, 1.0f, state::PrimaryOutput)
      .floatField("ch2", 0.0f, 0.0f, 1.0f, state::PrimaryOutput)
      .floatField("ch3", 0.0f, 0.0f, 1.0f, state::PrimaryOutput)
      .floatField("ch4", 0.0f, 0.0f, 1.0f, state::PrimaryOutput)
      .floatField("env", 0.0f, 0.0f, 1.0f, state::PrimaryOutput)
      // --- I/O ---
      .textureField("tex_in",  state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("orthomod_render", RENDER_SPV, RENDER_SPV_SIZE);
  auto cs = gpu::Device::createShaderModuleByName("orthomod_render");
  if (!cs) return;

  s_pso = gpu::Device::createComputePSO(cs, "main", gpu::Bindings()
      .tex2d(0)
      .storageTex2d(1, gpu::TextureFormat::RGBA8)
      .uniform(2)
      .storage(3));
  s_uniform_buf = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);
  s_page_buf    = gpu::Device::createBuffer(sizeof(uint32_t) * MAX_PAGE_BITS,
                                            gpu::BufferUsage::Storage);
  s_initialized = true;
  state::log("orthomod: initialized");
}

void tick(double dt) {
  if (!s_initialized) return;
  ensure_caches();

  float beat_mult = beat_multiplier_value(s_beat_multiplier_id);
  int crossings = s_tick.tick(beat_mult);
  if (crossings > 0) s_linear_env = 1.0;

  // Decay: linear_env loses 1 unit over decay_time_seconds.
  double bpm = host::bpm();
  if (bpm < 1.0) bpm = 120.0;
  double decay_time_seconds = (double)s_decay_time_beats * 60.0 / bpm;
  if (decay_time_seconds > 1e-5) {
    s_linear_env -= dt / decay_time_seconds;
    if (s_linear_env < 0.0) s_linear_env = 0.0;
  }

  // §2.1 accumulator: phase advances regardless of rate changes.
  if (s_mod_rate_hz > 0.0f) {
    s_mod_phase += dt * (double)s_mod_rate_hz;
    if (s_mod_phase > 1024.0) s_mod_phase -= std::floor(s_mod_phase);
  }
}

void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops) {
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* path = pb + off[i];
    int plen = len[i];

    if      (state::pathIs(path, plen, "beat_multiplier")) s_beat_multiplier_id   = (int)state::patchFloat(i);
    else if (state::pathIs(path, plen, "primary_hue"))     s_primary_hue          = state::patchFloat(i);
    else if (state::pathIs(path, plen, "saturation"))      s_saturation           = state::patchFloat(i);
    else if (state::pathIs(path, plen, "intensity"))       s_intensity            = state::patchFloat(i);
    else if (state::pathIs(path, plen, "decay_time_beats"))s_decay_time_beats     = state::patchFloat(i);
    else if (state::pathIs(path, plen, "decay_curve"))     s_decay_curve          = state::patchFloat(i);
    else if (state::pathIs(path, plen, "scatter_max"))     s_scatter_max          = state::patchFloat(i);
    else if (state::pathIs(path, plen, "channel_brightness_mod")) s_channel_brightness_mod = state::patchFloat(i);
    else if (state::pathIs(path, plen, "mod_rate_hz"))     s_mod_rate_hz          = state::patchFloat(i);
    else if (state::pathIs(path, plen, "hadamard_size")) {
      int v = (int)state::patchFloat(i);
      if (v != s_hadamard_size) { s_hadamard_size = v; s_sys_b_size_cached = -1; }
    }
    else if (state::pathIs(path, plen, "render_bits"))     s_render_bits          = (int)state::patchFloat(i);
    else if (state::pathIs(path, plen, "inset_top"))       s_inset_top            = state::patchFloat(i);
    else if (state::pathIs(path, plen, "inset_bottom"))    s_inset_bottom         = state::patchFloat(i);
    else if (state::pathIs(path, plen, "seed")) {
      int v = (int)state::patchFloat(i);
      if (v != s_seed) { s_seed = v; s_sys_a_dirty = true; s_sys_b_seed_cached = -1; }
    }
  }
}

static void publish_output(const char* name, float value) {
  auto vh = val::number(value);
  state::setValPath(name, vh);
  val::release(vh);
}

void render(int vp_w, int vp_h) {
  if (!s_initialized || vp_w <= 0 || vp_h <= 0) return;
  ensure_caches();

  auto in  = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!in.valid() || !out.valid()) return;

  // Compute env from linear_env with the decay curve.
  float linear = (float)s_linear_env;
  if (linear < 0.0f) linear = 0.0f;
  float env = std::pow(linear, fx::signedSliderToExp(clampf(s_decay_curve, -1.0f, 1.0f)));
  if (env < 0.0f) env = 0.0f;
  if (env > 1.0f) env = 1.0f;

  // System A — pick row by env.
  int idx_A = (int)std::floor((1.0f - env) * (float)SYS_A_N);
  idx_A = clampi(idx_A, 0, SYS_A_N - 1);
  const uint8_t* rowA = s_sys_a_rows[idx_A];

  // Per-bar 2-bit code → channel value.
  float ch[BARS];
  for (int b = 0; b < BARS; b++) {
    int code_msb = rowA[b * 2 + 0];
    int code_lsb = rowA[b * 2 + 1];
    ch[b] = channel_value(code_msb, code_lsb, s_mod_phase) * env;
  }

  // System B — pick page by env.
  int M = s_hadamard_size;
  int P = M / 4;
  if (P < 1) P = 1;
  int page_idx = (int)std::floor(env * (float)P);
  page_idx = clampi(page_idx, 0, P - 1);
  int raw_page = s_sys_b_page_order[page_idx];

  // Pack page bits (4 bars × M cols) into the GPU buffer.
  uint32_t page_bits[MAX_PAGE_BITS];
  for (int b = 0; b < BARS; b++) {
    int src_row = raw_page * 4 + b;
    for (int c = 0; c < M; c++) page_bits[b * M + c] = (uint32_t)s_sys_b_bits[src_row][c];
  }
  s_page_buf.writeBytes(page_bits, (int)sizeof(uint32_t) * BARS * M);

  // Uniforms.
  Uniforms u = {};
  u.ch0 = ch[0]; u.ch1 = ch[1]; u.ch2 = ch[2]; u.ch3 = ch[3];
  u.env = env;
  u.primary_hue = s_primary_hue;
  u.saturation = s_saturation;
  u.intensity = s_intensity;
  u.scatter_max = s_scatter_max;
  u.channel_brightness_mod = s_channel_brightness_mod;
  u.inset_top = clampf(s_inset_top, 0.0f, 0.5f);
  u.inset_bottom = clampf(s_inset_bottom, 0.0f, 0.5f);
  u.hadamard_size = (uint32_t)M;
  u.render_bits = (uint32_t)clampi(s_render_bits, 1, 64);
  u.page_idx = (uint32_t)page_idx;
  u.seed = (uint32_t)s_seed;
  s_uniform_buf.writeOne(u);

  // Dispatch.
  auto cp = gpu::ComputePass::begin();
  cp.setPSO(s_pso);
  cp.setTexture(in,  0, 0);
  cp.setTexture(out, 1, 1);
  cp.setBuffer(s_uniform_buf, 2);
  cp.setBuffer(s_page_buf,    3);
  cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
  cp.end();
  gpu::Device::submit();

  // Publish output rails.
  publish_output("ch1", ch[0]);
  publish_output("ch2", ch[1]);
  publish_output("ch3", ch[2]);
  publish_output("ch4", ch[3]);
  publish_output("env", env);
}

} // namespace orthomod
