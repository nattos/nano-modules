#pragma once
/*
 * effect_coupled_resonator.h — 4 coupled per-bar oscillators with
 * seeded diffusion and per-bar non-linear send-filter feedback.
 *
 * Used by gen.bounce_resonator (trigger-driven impulses) and the
 * planned fx.bounce_resonator (audio-energy-driven impulses).
 *
 * The model per spec (SHOW_EFFECTS_PLAN.md §390):
 *
 *   ÿ_i = -ω_i² · y_i                            // per-bar spring
 *         - 2 · ζ · ω_i · vy_i                    // damping (Q knob)
 *         + Σ_{j≠i} K_ij · (f_j(y_j) - y_i)      // diffusion via send filter
 *
 *   f_j(y) = biquad(tanh(pregain * y), coeffs[type, freq, q])
 *
 * Integration is Velocity Verlet with `sub_steps` sub-steps per frame
 * (default 8). The biquad runs at the SUB-STEP rate so its frequency
 * response is stable across sub_steps changes. A `tanh(vy / vmax) * vmax`
 * soft limiter applies after every sub-step — performer can crank Q
 * past 95% into self-resonance without runaway.
 *
 * Header-only, CPU-only, no GPU resources owned. The hosting effect
 * is responsible for uniform packing + rendering.
 *
 * Usage:
 *
 *   #include <effect_coupled_resonator.h>
 *
 *   static fx::CoupledResonator4 s_res;
 *
 *   void tick(double dt) {
 *     fx::CoupledResonator4::Params p;
 *     p.Q = s_Q; p.coupling = s_coupling; p.coupling_seed = s_seed;
 *     // ...
 *     s_res.setParams(p);
 *     s_res.step((float)dt);
 *   }
 *
 *   // On trigger:
 *   s_res.impulse(target_bar, s_impulse_strength, s_impulse_mode == 1);
 */

#include <cmath>
#include <cstdint>

namespace fx {

class CoupledResonator4 {
public:
  enum FilterType : int { LPF = 0, BPF = 1, HPF = 2 };
  enum ImpulseMode : int { Velocity = 0, Position = 1 };

  struct Params {
    float Q              = 0.3f;      // 0..1, performer slider; mapped log internally
    float coupling       = 0.3f;      // 0..1, overall diffusion strength
    uint32_t coupling_seed = 0;
    float cross_pregain  = 0.5f;      // 0..1, log-mapped to 0..+24 dB into tanh
    int   cross_filter_type = BPF;
    float cross_filter_freq = 0.5f;   // 0..1 log-mapped, 0.5..30 Hz
    float cross_filter_q    = 0.5f;   // 0..1 log-mapped, 0.5..20
    float base_freq_hz   = 4.0f;
    float bar_freq_spread = 0.2f;     // 0..1 log spread across the 4 bars
    float per_bar_freq_offsets[4] = {0.f, 0.f, 0.f, 0.f};
    float velocity_cap   = 0.5f;
    int   sub_steps      = 8;
  };

  void setParams(const Params& p) {
    if (params_.coupling_seed != p.coupling_seed) matrix_dirty_ = true;
    if (params_.coupling != p.coupling) matrix_dirty_ = true;
    if (params_.cross_filter_type != p.cross_filter_type
        || params_.cross_filter_freq != p.cross_filter_freq
        || params_.cross_filter_q != p.cross_filter_q
        || params_.sub_steps != p.sub_steps) {
      coeffs_dirty_ = true;
    }
    if (params_.Q != p.Q) damping_dirty_ = true;
    if (params_.base_freq_hz != p.base_freq_hz
        || params_.bar_freq_spread != p.bar_freq_spread
        || params_.per_bar_freq_offsets[0] != p.per_bar_freq_offsets[0]
        || params_.per_bar_freq_offsets[1] != p.per_bar_freq_offsets[1]
        || params_.per_bar_freq_offsets[2] != p.per_bar_freq_offsets[2]
        || params_.per_bar_freq_offsets[3] != p.per_bar_freq_offsets[3]) {
      omega_dirty_ = true;
    }
    params_ = p;
    if (params_.sub_steps < 1) params_.sub_steps = 1;
    if (params_.sub_steps > 32) params_.sub_steps = 32;
  }

  /// Kick one bar (`bar` ∈ [0, 4)). `Velocity` adds ±strength to the
  /// velocity; `Position` snaps the position to ±strength (sign random,
  /// alternating each call for visual variety).
  void impulse(int bar, float strength, ImpulseMode mode) {
    if (bar < 0 || bar >= 4) return;
    impulse_sign_ ^= 1u;
    float s = (impulse_sign_ & 1u) ? strength : -strength;
    if (mode == Position) {
      y_[bar]  = s;
      vy_[bar] = 0.0f;
    } else {
      vy_[bar] += s;
    }
  }

  /// Kick all four bars (signs alternate per bar for a "splash" look).
  void impulseAll(float strength, ImpulseMode mode) {
    for (int b = 0; b < 4; b++) {
      impulse(b, strength, mode);
    }
  }

  void step(float dt) {
    if (dt <= 0.0f) return;
    ensureLazyState();
    int N = params_.sub_steps;
    float sub_dt = dt / (float)N;
    float fs = 1.0f / sub_dt;          // sub-step sample rate (Hz)
    rebuildBiquadIfNeeded(fs);

    float vmax = params_.velocity_cap > 1e-4f ? params_.velocity_cap : 1e-4f;
    float pregain_db = params_.cross_pregain * 24.0f;
    float pregain = std::pow(10.0f, pregain_db / 20.0f);

    for (int s = 0; s < N; s++) {
      // 1. Compute send-filter output per bar:
      //    f_i = biquad(tanh(pregain * y_i)). Updates per-bar biquad
      //    state (z1, z2) at the sub-step rate.
      float f[4];
      for (int i = 0; i < 4; i++) {
        float pre = std::tanh(pregain * y_[i]);
        float w = pre - a1_ * z1_[i] - a2_ * z2_[i];
        float out = b0_ * w + b1_ * z1_[i] + b2_ * z2_[i];
        z2_[i] = z1_[i];
        z1_[i] = w;
        f[i] = out;
      }

      // 2. Compute acceleration per bar.
      float a[4];
      for (int i = 0; i < 4; i++) {
        float a_spring = -omega2_[i] * y_[i];
        float a_damp   = -two_zeta_omega_[i] * vy_[i];
        float a_diff   = 0.0f;
        for (int j = 0; j < 4; j++) {
          if (i == j) continue;
          a_diff += K_[i][j] * (f[j] - y_[i]);
        }
        a[i] = a_spring + a_damp + a_diff;
      }

      // 3. Velocity Verlet: integrate.
      //    Symplectic enough for visual purposes; closer to backward
      //    Euler for the damping term, which keeps high-Q rings stable.
      for (int i = 0; i < 4; i++) {
        vy_[i] += a[i] * sub_dt;
        // Soft velocity cap — engaged only when Q is past the self-
        // resonance threshold (ζ < 0). Otherwise it's effectively no-op
        // since |vy| stays well below vmax.
        vy_[i] = std::tanh(vy_[i] / vmax) * vmax;
        y_[i]  += vy_[i] * sub_dt;
      }
    }
  }

  void reset() {
    for (int i = 0; i < 4; i++) {
      y_[i] = 0.0f; vy_[i] = 0.0f;
      z1_[i] = 0.0f; z2_[i] = 0.0f;
    }
    matrix_dirty_ = coeffs_dirty_ = damping_dirty_ = omega_dirty_ = true;
    impulse_sign_ = 0;
  }

  float y(int bar)  const { return (bar >= 0 && bar < 4) ? y_[bar]  : 0.0f; }
  float vy(int bar) const { return (bar >= 0 && bar < 4) ? vy_[bar] : 0.0f; }

  /// Coupling matrix entry for debug overlays.
  float coupling(int i, int j) const {
    if (i < 0 || i >= 4 || j < 0 || j >= 4) return 0.0f;
    return K_[i][j];
  }

private:
  // Public-facing params, owned copy.
  Params params_;

  // Simulation state.
  float y_[4]   = {0.f, 0.f, 0.f, 0.f};
  float vy_[4]  = {0.f, 0.f, 0.f, 0.f};
  float z1_[4]  = {0.f, 0.f, 0.f, 0.f};
  float z2_[4]  = {0.f, 0.f, 0.f, 0.f};

  // Cached derived data.
  float K_[4][4] = {{0}};                 // row-sum-zero diffusion matrix
  float omega_[4]    = {0, 0, 0, 0};      // rad/sec per bar
  float omega2_[4]   = {0, 0, 0, 0};      // ω²
  float two_zeta_omega_[4] = {0, 0, 0, 0};
  float zeta_ = 0.1f;
  // Biquad coefficients (RBJ, normalized so a0 = 1).
  float b0_ = 1.f, b1_ = 0.f, b2_ = 0.f, a1_ = 0.f, a2_ = 0.f;
  float coeffs_fs_ = 0.f;                  // sample rate the cached coeffs assume

  bool matrix_dirty_  = true;
  bool coeffs_dirty_  = true;
  bool damping_dirty_ = true;
  bool omega_dirty_   = true;

  uint32_t impulse_sign_ = 0;

  void ensureLazyState() {
    if (omega_dirty_)   { rebuildOmegas();  omega_dirty_ = false;
                          damping_dirty_ = true; }     // ζ * ω depends on ω
    if (damping_dirty_) { rebuildDamping(); damping_dirty_ = false; }
    if (matrix_dirty_)  { rebuildMatrix();  matrix_dirty_  = false; }
    // Biquad coeffs depend on fs (sub-step rate) — rebuilt inside step().
  }

  void rebuildOmegas() {
    // Log spread across bars 0..3, centered on base_freq. spread=0
    // → all bars at base_freq; spread=1 → bars span base_freq * [1/2, 2].
    float base = params_.base_freq_hz > 1e-3f ? params_.base_freq_hz : 1e-3f;
    float spread = params_.bar_freq_spread;
    if (spread < 0.f) spread = 0.f;
    if (spread > 1.f) spread = 1.f;
    float max_stops = spread * 1.0f;   // up to ±1 stop = ×2 / ÷2
    for (int i = 0; i < 4; i++) {
      // -1..+1 across the 4 bars.
      float t = (float)i * (2.0f / 3.0f) - 1.0f;
      float f = base * std::pow(2.0f, t * max_stops + params_.per_bar_freq_offsets[i]);
      omega_[i]  = 2.0f * 3.14159265358979f * f;
      omega2_[i] = omega_[i] * omega_[i];
    }
  }

  void rebuildDamping() {
    // Slider mapping: bottom 80% audio-style Q sweep, top 5% goes
    // negative ζ for self-oscillation (caught by the velocity cap).
    //   Q slider 0    → ζ ≈ 0.5  (very heavy damping, short ring)
    //   Q slider 0.3  → ζ ≈ 0.05 (default — long, controlled ring)
    //   Q slider 0.8  → ζ ≈ 0.005 (very long ring)
    //   Q slider 0.95 → ζ ≈ 0     (sustained, on the verge of self-osc)
    //   Q slider 1.0  → ζ ≈ -0.05 (self-osc, cap engaged)
    float q = params_.Q;
    if (q < 0.f) q = 0.f;
    if (q > 1.f) q = 1.f;
    float zeta;
    if (q < 0.95f) {
      // pow(0.01, q/0.95) takes 0.5..0.005 across 0..0.95. Multiplied
      // by 0.5 to anchor the top end of the normal range.
      zeta = 0.5f * std::pow(0.01f, q / 0.95f);
    } else {
      // Linear interp into negative.
      float t = (q - 0.95f) / 0.05f;
      zeta = -0.05f * t;
    }
    zeta_ = zeta;
    for (int i = 0; i < 4; i++) {
      two_zeta_omega_[i] = 2.0f * zeta_ * omega_[i];
    }
  }

  void rebuildMatrix() {
    float strength = params_.coupling;
    if (strength < 0.f) strength = 0.f;
    if (strength > 1.f) strength = 1.f;

    // 1. Seeded off-diagonal entries (symmetric, [-1, +1] * strength).
    float maxabs = 0.0f;
    for (int i = 0; i < 4; i++) K_[i][i] = 0.0f;
    for (int i = 0; i < 4; i++) {
      for (int j = i + 1; j < 4; j++) {
        uint32_t h = params_.coupling_seed ^ ((uint32_t)(i * 4 + j) * 0x9E3779B1u);
        h ^= h >> 16; h *= 0x85EBCA6Bu;
        h ^= h >> 13; h *= 0xC2B2AE35u;
        h ^= h >> 16;
        float u = ((h >> 8) * (1.0f / (float)(1u << 24))) * 2.0f - 1.0f;
        float v = u * strength;
        K_[i][j] = v; K_[j][i] = v;
        float av = v < 0.f ? -v : v;
        if (av > maxabs) maxabs = av;
      }
    }
    // 2. Normalize so max(|K_ij|) = strength (bounds spectral radius).
    if (maxabs > 1e-6f && maxabs != strength) {
      float scale = strength / maxabs;
      for (int i = 0; i < 4; i++) {
        for (int j = 0; j < 4; j++) {
          if (i != j) K_[i][j] *= scale;
        }
      }
    }
    // 3. Row-sum-zero on diagonal — pure diffusion.
    for (int i = 0; i < 4; i++) {
      float row = 0.f;
      for (int j = 0; j < 4; j++) if (i != j) row += K_[i][j];
      K_[i][i] = -row;
    }
  }

  void rebuildBiquadIfNeeded(float fs) {
    if (!coeffs_dirty_ && fs == coeffs_fs_) return;
    coeffs_fs_ = fs;
    coeffs_dirty_ = false;

    // Slider → Hz (log) per spec — 0.5..30 Hz BPF, etc.
    float freq_slider = params_.cross_filter_freq;
    if (freq_slider < 0.f) freq_slider = 0.f;
    if (freq_slider > 1.f) freq_slider = 1.f;
    float f0 = 0.5f * std::pow(60.0f, freq_slider);    // 0.5..30 Hz
    // Nyquist guard at sub-step rate.
    float nyq = fs * 0.49f;
    if (f0 > nyq) f0 = nyq;

    float q_slider = params_.cross_filter_q;
    if (q_slider < 0.f) q_slider = 0.f;
    if (q_slider > 1.f) q_slider = 1.f;
    float q = 0.5f * std::pow(40.0f, q_slider);        // 0.5..20

    float w0 = 2.0f * 3.14159265358979f * f0 / fs;
    float cos_w0 = std::cos(w0);
    float sin_w0 = std::sin(w0);
    float alpha = sin_w0 / (2.0f * q);

    float a0, b0, b1, b2, a1, a2;
    switch (params_.cross_filter_type) {
      case LPF: {
        b0 = (1.0f - cos_w0) * 0.5f;
        b1 = 1.0f - cos_w0;
        b2 = (1.0f - cos_w0) * 0.5f;
        a0 = 1.0f + alpha;
        a1 = -2.0f * cos_w0;
        a2 = 1.0f - alpha;
      } break;
      case HPF: {
        b0 = (1.0f + cos_w0) * 0.5f;
        b1 = -(1.0f + cos_w0);
        b2 = (1.0f + cos_w0) * 0.5f;
        a0 = 1.0f + alpha;
        a1 = -2.0f * cos_w0;
        a2 = 1.0f - alpha;
      } break;
      case BPF:
      default: {
        b0 = alpha;
        b1 = 0.0f;
        b2 = -alpha;
        a0 = 1.0f + alpha;
        a1 = -2.0f * cos_w0;
        a2 = 1.0f - alpha;
      } break;
    }
    if (a0 == 0.0f) a0 = 1.0f;
    b0_ = b0 / a0; b1_ = b1 / a0; b2_ = b2 / a0;
    a1_ = a1 / a0; a2_ = a2 / a0;
  }
};

} // namespace fx
