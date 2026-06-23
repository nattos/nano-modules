/**
 * Effect catalog — the curated set of REAL effects a clip's device chain can host
 * (Component F: real clip chains).
 *
 * Each entry is a real effect that exists in a shipped production bundle
 * (core / nano / lights), with its float `PrimaryInput` fields (key + range +
 * default) transcribed from the effect's C++ schema. This catalog is the single
 * source of truth for:
 *   - building a real Structor `Sketch` from a clip (`clip-sketch.ts`),
 *   - seeding a device's default param state (`store.makeDevice`),
 *   - rendering the inspector's real param sliders,
 *   - the add-device palette (`availableEffects` in the column adapter).
 *
 * `role`: a `generator` device becomes the FIRST chain entry (a source that
 * produces pixels with no input); `effect` devices follow and the executor chains
 * them top-to-bottom — each reads the previous entry's output implicitly, no
 * wires. A clip with effect devices but no generator gets an implicit solid
 * stand-in as the first entry so the effects have a real input to process.
 *
 * Ids are the effect ids the bundles register (each effect's C++ `registerEffect`
 * id). Field ranges/defaults track the C++ `.floatField(name, def, min, max, ...)`
 * declarations (note the C++ arg order is default-first; `fld` here is
 * key/label/min/max/default). Only scalar float inputs are modelled — vec / color
 * / bool / enum / texture fields are intentionally omitted. The bundle for an
 * effect is loaded on demand when a clip first uses it. testonly is never loaded.
 * When runtime schema discovery is wired into the arrangement this catalog can be
 * derived instead of hand-kept.
 */

export interface EffectField {
  key: string;
  label: string;
  min: number;
  max: number;
  default: number;
}

export interface CatalogEffect {
  type: string;
  name: string;
  /** Bundle module id to loadModule() before use. */
  bundle: string;
  role: 'generator' | 'effect';
  fields: EffectField[];
  /** Declared scalar OUTPUTS (io&2) — e.g. a modulation source's value. Used to
   *  synthesize output schema entries so wires can connect from them. */
  outputs?: EffectField[];
}

const CORE = 'com.nano.core';
const NANO = 'com.nano.nano';
const LIGHTS = 'com.nano.lights';

const fld = (key: string, label: string, min: number, max: number, def: number): EffectField =>
  ({ key, label, min, max, default: def });

export const EFFECT_CATALOG: CatalogEffect[] = [
  // ══ core (com.nano.core) ════════════════════════════════════════════════
  // ── Generators ──────────────────────────────────────────────────────────
  {
    type: 'source.solid_color',
    name: 'Solid Color',
    bundle: CORE,
    role: 'generator',
    fields: [], // RGB color input only — no float sliders
  },
  {
    // Host-fed video frame source: the arrangement's main-thread decode pump
    // injects the decoded clip frame each tick. Not in the add-effect palette
    // (it's added automatically when a clip is backed by media).
    type: 'source.video.file',
    name: 'Video File',
    bundle: CORE,
    role: 'generator',
    fields: [],
  },
  {
    type: 'source.gradient',
    name: 'Gradient',
    bundle: CORE,
    role: 'generator',
    fields: [
      fld('angle', 'Angle', -1, 1, 0),
      fld('offset', 'Offset', -1, 1, 0),
      fld('softness', 'Softness', 0, 1, 1),
    ],
  },
  {
    type: 'source.grid',
    name: 'Grid',
    bundle: CORE,
    role: 'generator',
    fields: [
      fld('cell_size', 'Cell Size', 0, 1, 0.1),
      fld('line_width', 'Line Width', 0, 1, 0.04),
      fld('softness', 'Softness', 0, 1, 0.1),
    ],
  },
  {
    type: 'source.noise',
    name: 'Noise',
    bundle: CORE,
    role: 'generator',
    fields: [
      fld('scale', 'Scale', 0, 1, 0.5),
      fld('contrast', 'Contrast', -1, 1, 0),
      fld('seed', 'Seed', 0, 1, 0),
      fld('color', 'Color', 0, 1, 0),
      fld('speed', 'Speed', 0, 1, 0.5),
    ],
  },
  // ── Effects ───────────────────────────────────────────────────────────
  {
    type: 'color.hsl',
    name: 'HSL',
    bundle: CORE,
    role: 'effect',
    fields: [
      fld('hue_shift', 'Hue', -1, 1, 0),
      fld('saturation', 'Saturation', -1, 1, 0),
      fld('lightness', 'Lightness', -1, 1, 0),
    ],
  },
  {
    type: 'color.tone.brightness_contrast',
    name: 'Brightness / Contrast',
    bundle: CORE,
    role: 'effect',
    fields: [
      fld('brightness', 'Brightness', -1, 1, 0),
      fld('contrast', 'Contrast', -1, 1, 0),
    ],
  },
  {
    type: 'color.tone.curve',
    name: 'Curve',
    bundle: CORE,
    role: 'effect',
    fields: [
      fld('rgb', 'RGB', -1, 1, 0),
      fld('alpha', 'Alpha', -1, 1, 0),
    ],
  },
  {
    type: 'color.tone.exposure',
    name: 'Exposure',
    bundle: CORE,
    role: 'effect',
    fields: [fld('amount', 'Amount', -1, 1, 0)],
  },
  {
    type: 'color.tone.levels',
    name: 'Levels',
    bundle: CORE,
    role: 'effect',
    fields: [
      fld('in_low', 'Input Low', 0, 1, 0),
      fld('in_high', 'Input High', 0, 1, 1),
      fld('gamma', 'Gamma', -1, 1, 0),
      fld('out_low', 'Output Low', 0, 1, 0),
      fld('out_high', 'Output High', 0, 1, 1),
    ],
  },
  {
    type: 'color.tone.auto_level',
    name: 'Auto Level',
    bundle: CORE,
    role: 'effect',
    fields: [
      fld('equalize', 'Equalize', 0, 1, 0),
      fld('median_target', 'Median Target', 0, 1, 0.5),
      fld('median_pull', 'Median Pull', 0, 1, 0),
    ],
  },
  {
    type: 'color.saturate',
    name: 'Saturate',
    bundle: CORE,
    role: 'effect',
    fields: [
      fld('prescale', 'Prescale', 0, 4, 1),
      fld('asymm', 'Asymmetry', -1, 1, 0),
      fld('linear_deadzone', 'Deadzone', 0, 1, 0),
    ],
  },
  {
    type: 'color.vibrance',
    name: 'Vibrance',
    bundle: CORE,
    role: 'effect',
    fields: [fld('amount', 'Amount', -1, 1, 0)],
  },
  {
    type: 'color.temperature',
    name: 'Color Temperature',
    bundle: CORE,
    role: 'effect',
    fields: [fld('temperature', 'Temperature', -1, 1, 0)],
  },
  {
    type: 'color.posterize',
    name: 'Posterize',
    bundle: CORE,
    role: 'effect',
    fields: [fld('amount', 'Amount', 0, 1, 0.5)],
  },
  {
    type: 'color.hue_basis',
    name: 'Hue Basis',
    bundle: CORE,
    role: 'effect',
    fields: [
      fld('hue_a', 'Hue A', 0, 1, 0),
      fld('hue_b', 'Hue B', 0, 1, 1 / 3),
      fld('hue_c', 'Hue C', 0, 1, 2 / 3),
    ],
  },
  {
    type: 'color.invert',
    name: 'Invert',
    bundle: CORE,
    role: 'effect',
    fields: [], // bool 'invert_alpha' only — no float sliders
  },
  {
    type: 'composite.blend',
    name: 'Blend',
    bundle: CORE,
    role: 'effect',
    fields: [fld('opacity', 'Opacity', 0, 1, 0.5)],
  },
  {
    type: 'filter.vignette',
    name: 'Vignette',
    bundle: CORE,
    role: 'effect',
    fields: [
      fld('amount', 'Amount', -1, 1, -0.5),
      fld('radius', 'Radius', 0, 1, 0.6),
      fld('softness', 'Softness', 0, 1, 0.4),
      fld('shape', 'Shape', 0, 1, 0),
      fld('squash', 'Squash', -1, 1, 0),
    ],
  },
  {
    type: 'filter.blur.gaussian',
    name: 'Blur',
    bundle: CORE,
    role: 'effect',
    fields: [
      fld('radius', 'Radius', 0, 1, 0.25),
      fld('quality', 'Quality', 0, 1, 1),
    ],
  },
  {
    type: 'filter.sharpen',
    name: 'Sharpen',
    bundle: CORE,
    role: 'effect',
    fields: [
      fld('amount', 'Amount', 0, 1, 0.4),
      fld('radius', 'Radius', 0, 1, 0),
    ],
  },
  {
    type: 'filter.edges',
    name: 'Edges',
    bundle: CORE,
    role: 'effect',
    fields: [
      fld('threshold', 'Threshold', 0, 1, 0.1),
      fld('radius', 'Radius', 0, 1, 0),
      fld('keep_input', 'Keep Input', 0, 1, 0),
    ],
  },
  {
    type: 'filter.glitch.twitch_mask',
    name: 'Twitch Mask',
    bundle: CORE,
    role: 'effect',
    fields: [
      fld('amount', 'Amount', 0, 1, 0),
      fld('shape', 'Shape', -1, 1, -0.5),
      fld('radius', 'Radius', 0, 1, 0.3),
      fld('softness', 'Softness', 0, 1, 0.3),
      fld('position', 'Position', -1, 1, 0),
    ],
  },
  {
    type: 'motion.blur',
    name: 'Motion Blur',
    bundle: CORE,
    role: 'effect',
    fields: [
      fld('strength', 'Strength', 0, 4, 1),
      fld('chroma_r', 'Chroma R', -1, 1, 0.5),
      fld('chroma_g', 'Chroma G', -1, 1, 0),
      fld('chroma_b', 'Chroma B', -1, 1, -0.5),
    ],
  },
  {
    type: 'warp.crop',
    name: 'Crop',
    bundle: CORE,
    role: 'effect',
    fields: [
      fld('width', 'Width', 0, 1, 1),
      fld('height', 'Height', 0, 1, 1),
      fld('inset_left', 'Inset Left', 0, 1, 0),
      fld('inset_right', 'Inset Right', 0, 1, 0),
      fld('inset_top', 'Inset Top', 0, 1, 0),
      fld('inset_bottom', 'Inset Bottom', 0, 1, 0),
      fld('feather', 'Feather', 0, 1, 0),
    ],
  },
  {
    type: 'warp.transform',
    name: 'Transform',
    bundle: CORE,
    role: 'effect',
    fields: [
      fld('scale', 'Scale', -1, 1, 0),
      fld('rotation', 'Rotation', -1, 1, 0),
      fld('scale_aspect', 'Scale Aspect', -1, 1, 0),
    ],
  },

  // ══ nano (com.nano.nano) ════════════════════════════════════════════════
  {
    type: 'source.shape_fold',
    name: 'Shape Fold',
    bundle: NANO,
    role: 'generator',
    fields: [
      fld('frequency', 'Frequency', 0, 1, 0.25),
      fld('simplicity', 'Simplicity', 0, 1, 0.85),
      fld('temporal_complexity', 'Temporal Complexity', 0, 1, 0.66),
      fld('scale', 'Scale', 0.1, 8, 1),
      fld('time_speed', 'Time Speed', 0, 1, 0.58),
      fld('ease', 'Ease', -1, 1, 0),
      fld('birth_softness', 'Birth Softness', 0.02, 1, 0.45),
      fld('ap_speed', 'Autopilot Speed', 0, 1, 0.43),
      fld('ap_hold_period', 'Autopilot Hold Period', 0, 8, 2),
      fld('ap_hold_jitter', 'Autopilot Hold Jitter', 0, 1, 0),
      fld('level_ease', 'Level Ease', 0, 0.5, 0.25),
      fld('exposure', 'Exposure', 0, 4, 1),
    ],
  },
  {
    type: 'source.phase_fold',
    name: 'Phase Fold',
    bundle: NANO,
    role: 'generator',
    fields: [
      fld('eccentricity', 'Eccentricity', 0, 1, 0.2),
      fld('lobedness', 'Lobedness', 0, 1, 0.2),
      fld('wind', 'Wind', -1, 1, 0),
      fld('wind_jitter', 'Wind Jitter', 0, 1, 0),
      fld('wind_jitter_speed', 'Wind Jitter Speed', 0, 1, 0.5),
      fld('bias', 'Bias', -0.6, 0.6, 0),
      fld('scale', 'Scale', 0.1, 8, 1),
      fld('bands', 'Bands', 2, 24, 13),
      fld('contrast', 'Contrast', 0.4, 4, 1.6),
      fld('backdrop_dim', 'Backdrop Dim', 0, 1, 0.42),
      fld('stream_width', 'Stream Width', 0.002, 0.05, 0.012),
      fld('stream_spread', 'Stream Spread', 0.5, 4, 1.6),
      fld('flow_speed', 'Flow Speed', 0, 1, 0.5),
      fld('line_opacity', 'Line Opacity', 0, 1, 0.55),
      fld('cycle_width', 'Cycle Width', 0.004, 0.06, 0.02),
      fld('arc_angle', 'Arc Angle', 0, 1, 0),
      fld('trace_pull', 'Trace Pull', 0, 0.4, 0.05),
      fld('trace_step', 'Trace Step', 0.002, 0.06, 0.02),
      fld('trace_steps', 'Trace Steps', 1, 16, 4),
      fld('trace_eps', 'Trace Eps', 0.01, 0.2, 0.06),
      fld('solve_steps', 'Solve Steps', 1, 16, 4),
      fld('step_size', 'Step Size', 0, 1, 0.75),
      fld('momentum', 'Momentum', 0, 0.95, 0.6),
      fld('morph_rate', 'Morph Rate', 0, 1, 0.1),
      fld('respawn_arc', 'Respawn Arc', 0, 4, 1),
      fld('break_turn', 'Break Turn', 0, 1, 0.5),
      fld('break_dist', 'Break Dist', 0.05, 0.6, 0.2),
      fld('respawn_time', 'Respawn Time', 0.1, 10, 2),
      fld('explore', 'Explore', 0, 1, 0.3),
      fld('spread', 'Spread', 0, 1, 0.5),
      fld('ap_speed', 'Autopilot Speed', 0, 1, 0.35),
      fld('jitter', 'Jitter', 0, 1, 0),
      fld('jitter_speed', 'Jitter Speed', 0, 1, 0.5),
    ],
  },
  {
    type: 'source.particles.flash_particles',
    name: 'Flash Particles',
    bundle: NANO,
    role: 'generator',
    fields: [
      fld('life', 'Life', 0.05, 10, 1.5),
      fld('respawn_delay', 'Respawn Delay', 0, 10, 0.3),
      fld('life_jitter', 'Life Jitter', 0, 1, 0.3),
      fld('mask_temperature', 'Mask Temperature', 0, 4, 0),
      fld('width', 'Width', 0.001, 1, 0.05),
      fld('height', 'Height', 0.001, 1, 0.05),
      fld('width_jitter', 'Width Jitter', 0, 1, 0.3),
      fld('height_jitter', 'Height Jitter', 0, 1, 0.3),
      fld('global_scale', 'Global Scale', 0.01, 4, 1),
      fld('rotation', 'Rotation', -360, 360, 0),
      fld('rotation_jitter', 'Rotation Jitter', 0, 360, 30),
      fld('shape_param', 'Shape Param', 0, 1, 0.5),
      fld('alpha_curve', 'Alpha Curve', 0.25, 4, 1.5),
      fld('frame_alpha_jitter', 'Frame Alpha Jitter', 0, 1, 0),
      fld('color_blend', 'Color Blend', 0, 1, 0.5),
      fld('hue_jitter', 'Hue Jitter', 0, 1, 0.1),
      fld('brightness_jitter', 'Brightness Jitter', 0, 1, 0.1),
      fld('saturation_jitter', 'Saturation Jitter', 0, 1, 0.1),
      fld('alpha_jitter', 'Alpha Jitter', 0, 1, 0.1),
      fld('input_alpha', 'Input Alpha', 0, 1, 1),
      fld('exposure', 'Exposure', 0, 8, 1),
      fld('color_alpha', 'Color Alpha', 0, 1, 1),
      fld('motion_strength', 'Motion Strength', 0, 1, 0.5),
    ],
  },
  {
    type: 'source.particles.flow_swarm',
    name: 'Flow Swarm',
    bundle: NANO,
    role: 'generator',
    fields: [
      fld('speed', 'Speed', 0, 8, 1.5),
      fld('momentum', 'Momentum', 0, 0.99, 0),
      fld('weight', 'Weight', 0.05, 8, 1),
      fld('pull', 'Pull', 0, 1, 0),
      fld('jitter', 'Jitter', 0, 1, 0),
      fld('drag', 'Drag', 0, 4, 0.1),
      fld('size', 'Size', 0, 1, 0.3),
      fld('size_jitter', 'Size Jitter', 0, 1, 0.5),
      fld('life', 'Life', 0.1, 30, 4),
      fld('life_jitter', 'Life Jitter', 0, 1, 0.4),
      fld('color_blend', 'Color Blend', 0, 1, 0.3),
      fld('tint_by_flow', 'Tint By Flow', 0, 1, 0),
      fld('undertow_split', 'Undertow Split', 0, 1, 0),
      fld('undertow_polarity', 'Undertow Polarity', -2, 2, 1),
      fld('undertow_curl', 'Undertow Curl', -1, 1, 0),
      fld('undertow_alpha', 'Undertow Alpha', 0, 2, 1),
      fld('interaction_radius', 'Interaction Radius', 0.002, 0.08, 0.015),
      fld('density_threshold', 'Density Threshold', 0, 32, 4),
      fld('density_death', 'Density Death', 0, 1, 0),
      fld('avoid', 'Avoid', 0, 1, 0),
      fld('avoid_curl', 'Avoid Curl', -1, 1, 0),
      fld('avoid_noise', 'Avoid Noise', 0, 1, 0.08),
      fld('stream', 'Stream', -1, 1, 0),
      fld('stream_density', 'Stream Density', 0.5, 32, 3),
      fld('opacity', 'Opacity', 0, 1, 1),
      fld('input_alpha', 'Input Alpha', 0, 1, 1),
      fld('shape_param', 'Shape Param', 0, 1, 0.5),
      fld('alpha_curve', 'Alpha Curve', 0.25, 4, 0.6),
      fld('exposure', 'Exposure', 0, 8, 1),
    ],
  },
  {
    type: 'motion.field',
    name: 'Motion Field',
    bundle: NANO,
    role: 'effect',
    fields: [
      fld('threshold', 'Threshold', 0, 1, 0.5),
      fld('softness', 'Softness', 0, 0.5, 0.05),
      fld('magnitude', 'Magnitude', 0, 0.05, 0.005),
      fld('mag_jitter', 'Mag Jitter', 0, 1, 0.5),
      fld('mag_noise_scale', 'Mag Noise Scale', 1, 100, 16),
      fld('rotation', 'Rotation', -360, 360, 0),
      fld('rotation_weight', 'Rotation Weight', 0, 1, 1),
      fld('radial_weight', 'Radial Weight', 0, 1, 0),
      fld('gradient_weight', 'Gradient Weight', 0, 1, 0),
      fld('gradient_bias', 'Gradient Bias', -180, 180, 90),
      fld('angle_jitter', 'Angle Jitter', 0, 1, 0),
      fld('angle_noise_scale', 'Angle Noise Scale', 1, 100, 16),
      fld('evolution_rate', 'Evolution Rate', 0, 60, 0),
      fld('vis_opacity', 'Vis Opacity', 0, 1, 0),
      fld('vis_scale', 'Vis Scale', 1, 500, 100),
    ],
  },
  {
    type: 'motion.local_delay',
    name: 'Local Delay',
    bundle: NANO,
    role: 'effect',
    fields: [
      fld('delay_amount', 'Delay Amount', 0, 1, 0.7),
      fld('delay_steps', 'Delay Steps', 1, 32, 12),
      fld('smoothing', 'Smoothing', 0, 1, 0.4),
      fld('noise_weight', 'Noise Weight', 0, 1, 0),
      fld('noise_motion', 'Noise Motion', 0, 1, 0),
      fld('vignette', 'Vignette', -1, 1, 0),
      fld('vignette_radius', 'Vignette Radius', 0, 1, 0.5),
      fld('vignette_softness', 'Vignette Softness', 0, 1, 0.3),
      fld('twitch_amount', 'Twitch Amount', 0, 1, 0),
      fld('twitch_shape', 'Twitch Shape', -1, 1, -0.5),
      fld('twitch_radius', 'Twitch Radius', 0, 1, 0.3),
      fld('twitch_softness', 'Twitch Softness', 0, 1, 0.3),
      fld('twitch_position', 'Twitch Position', -1, 1, 0),
      fld('squash', 'Squash', -1, 1, 0),
      fld('max_flow', 'Max Flow', 0, 0.1, 0.03),
      fld('weight_gain', 'Weight Gain', 0, 1, 0.5),
      fld('align_amount', 'Align Amount', 0, 1, 0.5),
      fld('align_sharpness', 'Align Sharpness', 1, 16, 4),
      fld('motion_gain', 'Motion Gain', 0, 1, 0.03),
    ],
  },
  {
    type: 'filter.height_from_gradient',
    name: 'Height From Gradient',
    bundle: NANO,
    role: 'effect',
    fields: [
      fld('grad_gain', 'Grad Gain', 0, 1, 1),
      fld('core_radius', 'Core Radius', 0, 1, 0.12),
      fld('core_softness', 'Core Softness', 0, 1, 0.5),
      fld('sweep_angle', 'Sweep Angle', 0, 1, 0),
      fld('edge_threshold', 'Edge Threshold', 0, 1, 0.1),
      fld('edge_gain', 'Edge Gain', 0, 1, 0.5),
      fld('mix', 'Mix', 0, 1, 0),
      fld('light_angle', 'Light Angle', 0, 1, 0.375),
      fld('light_elevation', 'Light Elevation', 0, 1, 0.5),
      fld('relief_scale', 'Relief Scale', 0, 1, 0.4),
      fld('light_gain', 'Light Gain', 0, 1, 1),
      fld('ambient', 'Ambient', 0, 1, 0.15),
      fld('height_scale', 'Height Scale', 0, 8, 1),
      fld('height_offset', 'Height Offset', -1, 1, 0),
      fld('contour_density', 'Contour Density', 0, 1, 0.2),
      fld('line_width', 'Line Width', 0, 1, 0.5),
    ],
  },

  // ══ lights (com.nano.lights) ════════════════════════════════════════════
  {
    type: 'source.light.strobe_channel',
    name: 'Strobe Channel',
    bundle: LIGHTS,
    role: 'generator',
    fields: [
      fld('r', 'R', 0, 4, 3.95),
      fld('ping_pong_rate_hz', 'Ping Pong Rate', 0.05, 20, 0.5),
      fld('seed_low', 'Seed Low', 0, 1, 0.1),
      fld('seed_high', 'Seed High', 0, 1, 0.9),
      fld('intensity', 'Intensity', 0, 2, 1),
      fld('intensity_mod', 'Intensity Mod', -1, 1, 0),
    ],
  },
  {
    type: 'source.light.soft_glow',
    name: 'Soft Glow',
    bundle: LIGHTS,
    role: 'generator',
    fields: [
      fld('intensity', 'Intensity', 0, 2, 1),
      fld('intensity_mod', 'Intensity Mod', -1, 1, 0),
      fld('fade_time', 'Fade Time', 0.05, 10, 3),
      fld('blob_size', 'Blob Size', 0.05, 1, 0.4),
      fld('blob_size_jitter', 'Blob Size Jitter', 0, 1, 0.3),
      fld('drift_rate', 'Drift Rate', 0, 1, 0.2),
      fld('drift_x_bias', 'Drift X Bias', -1, 1, 0),
      fld('drift_y_bias', 'Drift Y Bias', -1, 1, 0),
      fld('hue', 'Hue', 0, 1, 0.05),
      fld('hue_shift', 'Hue Shift', -3, 3, 0.3),
      fld('hue_curve', 'Hue Curve', -1, 1, 0),
      fld('overflow_band', 'Overflow Band', 0, 3, 0),
      fld('color_strength', 'Color Strength', 0, 4, 1),
      fld('saturation', 'Saturation', 0, 1, 0.95),
      fld('intensity_skew', 'Intensity Skew', 0, 1, 0),
      fld('ramp_curve', 'Ramp Curve', -1, 1, 0),
      fld('white_point', 'White Point', 0.5, 3, 1.5),
      fld('pulse_depth', 'Pulse Depth', 0, 1, 0.4),
      fld('pulse_rate', 'Pulse Rate', 0, 3, 0.6),
      fld('amp_drift_depth', 'Amp Drift Depth', 0, 1, 0.9),
      fld('amp_drift_rate', 'Amp Drift Rate', 0, 1, 0.08),
      fld('motion_strength', 'Motion Strength', 0, 8, 1),
      fld('motion_skew', 'Motion Skew', 0, 1, 0),
      fld('motion_curl', 'Motion Curl', -1, 1, 0),
      fld('motion_extent', 'Motion Extent', 0, 1, 1),
    ],
  },
  {
    type: 'source.light.orthomod',
    name: 'Orthomod',
    bundle: LIGHTS,
    role: 'generator',
    fields: [
      fld('primary_hue', 'Primary Hue', 0, 1, 0.08),
      fld('saturation', 'Saturation', 0, 1, 0.9),
      fld('intensity', 'Intensity', 0, 2, 1),
      fld('decay_time_beats', 'Decay Time', 0.05, 4, 1),
      fld('decay_curve', 'Decay Curve', -1, 1, 0),
      fld('release_time_beats', 'Release Time', 0.05, 4, 0.5),
      fld('release_curve', 'Release Curve', -1, 1, 0),
      fld('scatter_max', 'Scatter Max', 0, 0.5, 0.15),
      fld('channel_brightness_mod', 'Channel Brightness Mod', 0, 1, 0.5),
      fld('env_brightness_curve', 'Env Brightness Curve', -1, 1, 0),
      fld('mod_rate_hz', 'Mod Rate', 0, 30, 15),
      fld('start', 'Start', 0, 1, 0),
      fld('end', 'End', 0, 1, 1),
      fld('inset_top', 'Inset Top', 0, 0.5, 0),
      fld('inset_bottom', 'Inset Bottom', 0, 0.5, 0),
      fld('decay_jitter', 'Decay Jitter', 0, 1, 0),
    ],
  },
  {
    type: 'source.light.bounce_resonator',
    name: 'Bounce Resonator',
    bundle: LIGHTS,
    role: 'generator',
    fields: [
      fld('auto_rate', 'Auto Rate', 0, 1, 0.3),
      fld('tex_in_boost', 'Input Boost', 0, 10, 1),
      fld('feedback', 'Feedback', 0, 1.2, 0.9),
      fld('spread', 'Spread', 0, 1, 0.3),
      fld('spread_contrast', 'Spread Contrast', 0, 1, 0),
      fld('decay_shaping', 'Decay Shaping', -1, 1, 0),
      fld('hue_spread', 'Hue Spread', 0, 1, 0),
      fld('hue_converge', 'Hue Converge', 0, 1, 0),
      fld('cycle_rate', 'Cycle Rate', 0, 60, 6),
      fld('impulse_strength', 'Impulse Strength', 0, 2, 1),
      fld('intensity', 'Intensity', 0, 10, 1),
      fld('input_opacity', 'Input Opacity', 0, 1, 1),
    ],
  },
  {
    type: 'source.light.motion_blobs',
    name: 'Motion Blobs',
    bundle: LIGHTS,
    role: 'generator',
    fields: [
      fld('density', 'Density', 0, 1, 0.4),
      fld('traverse_speed', 'Traverse Speed', 0, 3, 0.7),
      fld('traverse_speed_jitter', 'Traverse Speed Jitter', 0, 1, 0.5),
      fld('drift', 'Drift', -1, 1, 0),
      fld('center_bias', 'Center Bias', -1, 1, 0),
      fld('arc_bias', 'Arc Bias', -1, 1, 0),
      fld('arc_scale', 'Arc Scale', 0, 1.5, 0.5),
      fld('motion_strength', 'Motion Strength', 0, 2, 1),
      fld('motion_extent', 'Motion Extent', 0, 1, 1),
      fld('shadow_darkness', 'Shadow Darkness', 0, 1, 0),
      fld('blob_size', 'Blob Size', 0, 1, 0.12),
      fld('blob_size_jitter', 'Blob Size Jitter', 0, 1, 0.3),
      fld('drift_jitter', 'Drift Jitter', 0, 0.5, 0.1),
      fld('softness_curve', 'Softness Curve', 1, 16, 4),
    ],
  },
  {
    type: 'source.light.plasma_beam_cannon',
    name: 'Plasma Beam Cannon',
    bundle: LIGHTS,
    role: 'generator',
    fields: [
      fld('seed_y', 'Seed Y', 0, 1, 0.5),
      fld('seed_height', 'Seed Height', 0, 0.5, 0.06),
      fld('attack_s', 'Attack', 0, 1, 0.15),
      fld('decay_s', 'Decay', 0, 0.5, 0.1),
      fld('sustain_s', 'Sustain', 0, 4, 0.4),
      fld('release_s', 'Release', 0.1, 5, 1.5),
      fld('attack_curve', 'Attack Curve', -1, 1, 0),
      fld('decay_curve', 'Decay Curve', -1, 1, 0),
      fld('release_curve', 'Release Curve', -1, 1, 0),
      fld('intensity', 'Intensity', 0, 2, 1),
      fld('auto_rate', 'Auto Rate', 0, 1, 0.2),
      fld('attractor_fraction', 'Attractor Fraction', 0, 1, 0.25),
      fld('spacer_fraction', 'Spacer Fraction', 0, 1, 0.25),
      fld('min_break_size', 'Min Break Size', 0.001, 0.2, 0.015),
      fld('max_break_size', 'Max Break Size', 0.01, 0.5, 0.12),
      fld('force_strength', 'Force Strength', 0, 2, 0.4),
      fld('spacer_strength', 'Spacer Strength', 0, 1, 0.3),
      fld('force_softening', 'Force Softening', 0.005, 0.5, 0.05),
      fld('damping_per_s', 'Damping', 0.1, 10, 4),
      fld('interaction_radius', 'Interaction Radius', 0.05, 1, 0.3),
      fld('teleport_rate', 'Teleport Rate', 0, 1, 0.2),
      fld('length_target_start', 'Length Start', 0, 1, 0.1),
      fld('length_target_end', 'Length End', 0, 1, 0.7),
      fld('length_target_curve', 'Length Curve', 0.25, 4, 1),
      fld('grow_response', 'Grow Response', 0, 4, 1),
      fld('activation_curve', 'Activation Curve', -1, 1, 0),
      fld('activation_min', 'Activation Min', 0, 1, 0),
      fld('growth_fraction', 'Growth Fraction', 0, 1, 0.4),
      fld('flicker_start_t', 'Flicker Start', 0, 1, 0.7),
      fld('flicker_duty_start', 'Flicker Duty Start', 0, 1, 0.8),
      fld('flicker_duty_end', 'Flicker Duty End', 0, 1, 0.05),
      fld('flicker_freq_hz', 'Flicker Freq', 1, 60, 24),
    ],
  },
  {
    type: 'source.light.side_jet',
    name: 'Side Jet',
    bundle: LIGHTS,
    role: 'generator',
    fields: [
      fld('throttle', 'Throttle', 0, 1, 0.7),
      fld('mixture', 'Mixture', 0, 1, 0.3),
      fld('intensity', 'Intensity', 0, 3, 1),
      fld('drama', 'Drama', 0, 1, 0),
      fld('spool_time', 'Spool Time', 0.01, 1, 0.06),
      fld('startup_overshoot', 'Startup Overshoot', 0, 1, 0.4),
      fld('overshoot_time', 'Overshoot Time', 0.02, 2, 0.18),
      fld('centerline_y', 'Centerline Y', 0, 1, 0.5),
      fld('nozzle_radius', 'Nozzle Radius', 0.02, 0.5, 0.45),
      fld('spread', 'Spread', 0, 1, 0.15),
      fld('length_scale', 'Length Scale', 0.2, 1.5, 1),
      fld('core_brightness', 'Core Brightness', 0, 3, 1.7),
      fld('radial_sharpness', 'Radial Sharpness', 1, 16, 5),
      fld('diamond_amp', 'Diamond Amp', 0, 1, 0.6),
      fld('diamond_spacing', 'Diamond Spacing', 0.01, 0.2, 0.06),
      fld('mach_disk_amp', 'Mach Disk Amp', 0, 2, 0.8),
      fld('core_length', 'Core Length', 0.2, 3, 1),
      fld('shear_turbulence', 'Shear Turbulence', 0, 1, 0.5),
      fld('shear_scale', 'Shear Scale', 4, 40, 18),
      fld('crackle', 'Crackle', 0, 1, 0.3),
      fld('shimmer_rate_hz', 'Shimmer Rate', 0, 30, 9),
      fld('kh_rate_hz', 'KH Rate', 0, 30, 6),
      fld('crackle_rate_hz', 'Crackle Rate', 0, 60, 22),
      fld('zoom', 'Zoom', 1, 12, 1),
      fld('propagation', 'Propagation', 0, 1, 0.6),
      fld('motion_scale', 'Motion Scale', 0, 1, 0.5),
      fld('spark_amount', 'Spark Amount', 0, 1, 0.6),
      fld('spark_rate', 'Spark Rate', 0, 60, 12),
      fld('spark_scale', 'Spark Scale', 0.1, 5, 1),
      fld('spark_speed', 'Spark Speed', 0.1, 5, 1.6),
    ],
  },
  {
    type: 'source.light.tingle_top',
    name: 'Tingle Top',
    bundle: LIGHTS,
    role: 'generator',
    fields: [
      fld('level', 'Level', 0, 1, 0),
      fld('auto_rate', 'Auto Rate', 0, 1, 0),
      fld('top_band_height', 'Top Band Height', 0.01, 0.5, 0.1),
      fld('release_s', 'Release', 0.05, 4, 0.8),
      fld('release_curve', 'Release Curve', 0.25, 4, 1.5),
      fld('release_tilt', 'Release Tilt', -1, 1, 0),
      fld('min_sustain_s', 'Min Sustain', 0, 2, 0.3),
      fld('intensity', 'Intensity', 0, 2, 1),
      fld('hue', 'Hue', 0, 1, 0.12),
      fld('hue_jitter', 'Hue Jitter', 0, 0.5, 0.08),
      fld('particle_life_ms', 'Particle Life', 10, 1000, 200),
      fld('respawn_delay_ms', 'Respawn Delay', 0, 500, 30),
      fld('life_jitter', 'Life Jitter', 0, 1, 0.4),
      fld('size', 'Size', 0.001, 0.05, 0.008),
      fld('size_jitter', 'Size Jitter', 0, 1, 0.5),
      fld('frame_alpha_jitter', 'Frame Alpha Jitter', 0, 1, 0.6),
      fld('shape_param', 'Shape Param', 0, 1, 0.7),
      fld('alpha_curve', 'Alpha Curve', 0.25, 4, 1.5),
      fld('particle_velocity_y', 'Velocity Y', -2, 2, 0),
      fld('particle_velocity_x', 'Velocity X', -2, 2, 0),
      fld('velocity_y_jitter', 'Velocity Y Jitter', 0, 1, 0),
      fld('velocity_x_jitter', 'Velocity X Jitter', 0, 1, 0),
    ],
  },
  {
    type: 'source.light.chroma_wave',
    name: 'Chroma Wave',
    bundle: LIGHTS,
    role: 'generator',
    fields: [
      fld('level', 'Level', 0, 1, 0),
      fld('auto_rate', 'Auto Rate', 0, 1, 0.15),
      fld('voice_pos_jitter', 'Voice Pos Jitter', 0, 2, 0.5),
      fld('voice_hue_jitter', 'Voice Hue Jitter', 0, 1, 0.1),
      fld('hue_interact', 'Hue Interact', 0, 2, 0.8),
      fld('position_x', 'Position X', -2, 2, 0),
      fld('position_y', 'Position Y', -2, 2, -0.7),
      fld('charge_s', 'Charge', 0.05, 3, 0.6),
      fld('base_radius', 'Base Radius', 0.01, 10, 0.12),
      fld('charge_expand', 'Charge Expand', 1, 8, 2.3),
      fld('size_smoothing', 'Size Smoothing', 0, 1, 0.06),
      fld('gaussian_sharpness', 'Gaussian Sharpness', 1, 20, 4),
      fld('plateau_amount', 'Plateau Amount', 0, 1, 0.6),
      fld('squish_amount', 'Squish Amount', 0, 2, 0.5),
      fld('crescent_amount', 'Crescent Amount', 0, 1, 0.7),
      fld('crescent_offset', 'Crescent Offset', 0.1, 1.5, 0.5),
      fld('release_s', 'Release', 0.05, 20, 0.7),
      fld('release_expand', 'Release Expand', 1, 20, 3),
      fld('release_curve', 'Release Curve', -1, 1, 0.4),
      fld('min_sustain_s', 'Min Sustain', 0, 1, 0.2),
      fld('burst_shallow', 'Burst Shallow', 0, 0.95, 0.7),
      fld('base_hue', 'Base Hue', 0, 1, 0.55),
      fld('hue_span', 'Hue Span', 0, 1, 0.18),
      fld('saturation', 'Saturation', 0, 1, 0.85),
      fld('hue_shift_r', 'Hue Shift R', -1, 1, 0),
      fld('hue_shift_g', 'Hue Shift G', -1, 1, 0),
      fld('hue_shift_b', 'Hue Shift B', -1, 1, 0),
      fld('grade_freq_hold', 'Grade Freq Hold', 0, 8, 1.5),
      fld('grade_freq_burst', 'Grade Freq Burst', 0, 16, 7),
      fld('fold_rate', 'Fold Rate', 0, 8, 1.5),
      fld('band_contrast', 'Band Contrast', 0, 1, 0.6),
      fld('band_tilt', 'Band Tilt', -2, 2, 0),
      fld('alpha_gamma', 'Alpha Gamma', 0.25, 4, 1.2),
      fld('overlay_alpha_hold', 'Overlay Alpha Hold', 0, 1, 0.3),
      fld('overlay_alpha_burst', 'Overlay Alpha Burst', 0, 1, 0.7),
      fld('intensity', 'Intensity', 0, 32, 1),
      fld('motion_scale', 'Motion Scale', 0, 1, 1),
      fld('motion_warp', 'Motion Warp', 0, 1, 0.4),
      fld('motion_edge_mask', 'Motion Edge Mask', 0, 1, 0),
    ],
  },
  {
    type: 'warp.dispersion',
    name: 'Dispersion',
    bundle: LIGHTS,
    role: 'effect',
    fields: [
      fld('vertical_block_norm', 'Vertical Block', 0, 1, 0.1),
      fld('horizontal_block_norm', 'Horizontal Block', 0, 1, 0.1),
      fld('offset_max', 'Offset Max', 0, 0.5, 0.08),
      fld('intensity', 'Intensity', 0, 1, 1),
      fld('temporal_rate_hz', 'Temporal Rate', 0, 60, 60),
    ],
  },
  {
    type: 'filter.lights_sim',
    name: 'Lights Sim',
    bundle: LIGHTS,
    role: 'effect',
    fields: [
      fld('inset_h', 'Inset H', 0, 1, 0.8),
      fld('inset_v', 'Inset V', 0, 1, 0.05),
      fld('input_opacity', 'Input Opacity', 0, 1, 0.25),
    ],
  },
  {
    type: 'filter.glitch.block_dehance',
    name: 'Block Dehance',
    bundle: LIGHTS,
    role: 'effect',
    fields: [
      fld('life_s', 'Life', 0.05, 10, 1.5),
      fld('respawn_delay_s', 'Respawn Delay', 0, 10, 1),
      fld('life_jitter', 'Life Jitter', 0, 1, 0.3),
      fld('rect_width', 'Rect Width', 0.005, 1, 0.18),
      fld('rect_height', 'Rect Height', 0.005, 1, 0.06),
      fld('rect_size_jitter', 'Rect Size Jitter', 0, 1, 0.4),
      fld('move_chance', 'Move Chance', 0, 1, 0),
      fld('move_amount', 'Move Amount', 0, 0.5, 0.03),
      fld('move_delay_max', 'Move Delay Max', 0, 5, 0.3),
      fld('mask_temperature', 'Mask Temperature', 0, 4, 0.5),
      fld('mode_black_weight', 'Black Weight', 0, 1, 0.33),
      fld('mode_mosaic_weight', 'Mosaic Weight', 0, 1, 0.33),
      fld('mode_noise_weight', 'Noise Weight', 0, 1, 0.33),
      fld('mosaic_cell_size', 'Mosaic Cell Size', 0.001, 0.2, 0.02),
      fld('mosaic_cell_size_jitter', 'Mosaic Cell Jitter', 0, 1, 0.5),
      fld('noise_intensity', 'Noise Intensity', 0, 1, 1),
      fld('flicker_rate_hz', 'Flicker Rate', 0, 60, 0),
      fld('flicker_duty', 'Flicker Duty', 0, 1, 0.5),
    ],
  },

  // ══ mod (com.nano.core / com.nano.nano) — modulation sources + shapers ════
  // Pure-data nodes: no texture I/O. Their scalar `output` is a connectable wire
  // source. NOTE: live modulation execution through the arrangement compositor
  // is NOT wired yet (see MOCKUP_NOTES) — the nodes + outputs exist for wiring.
  {
    type: 'mod.source.lfo', name: 'LFO', bundle: CORE, role: 'effect',
    fields: [fld('rate', 'Rate', 0, 1, 0.5), fld('amplitude', 'Amplitude', 0, 1, 1), fld('shape', 'Shape', 0, 1, 0)],
    outputs: [fld('output', 'Output', 0, 1, 0)],
  },
  {
    type: 'mod.source.adsr', name: 'ADSR', bundle: CORE, role: 'effect',
    fields: [fld('attack', 'Attack', 0, 1, 0.05), fld('decay', 'Decay', 0, 1, 0.3),
      fld('sustain', 'Sustain', 0, 1, 0.5), fld('release', 'Release', 0, 1, 0.3)],
    outputs: [fld('output', 'Output', 0, 1, 0)],
  },
  {
    type: 'mod.source.spectral_lfo', name: 'Spectral LFO', bundle: NANO, role: 'effect',
    fields: [fld('rate', 'Rate', 0, 1, 0.4), fld('amplitude', 'Amplitude', 0, 1, 1),
      fld('morph_x', 'Morph X', 0, 1, 0.5), fld('morph_y', 'Morph Y', 0, 1, 0.5)],
    outputs: [fld('output', 'Output', 0, 1, 0)],
  },
  {
    type: 'mod.shaper.remap', name: 'Remap', bundle: CORE, role: 'effect',
    fields: [fld('input', 'Input', 0, 1, 0), fld('in_min', 'In Min', -1, 1, 0), fld('in_max', 'In Max', -1, 1, 1),
      fld('out_min', 'Out Min', -1, 1, 0), fld('out_max', 'Out Max', -1, 1, 1)],
    outputs: [fld('output', 'Output', 0, 1, 0)],
  },
  {
    type: 'mod.shaper.smooth', name: 'Smooth', bundle: CORE, role: 'effect',
    fields: [fld('input', 'Input', 0, 1, 0), fld('amount', 'Amount', 0, 1, 0.5)],
    outputs: [fld('output', 'Output', 0, 1, 0)],
  },
  {
    type: 'mod.shaper.delay', name: 'Delay', bundle: CORE, role: 'effect',
    fields: [fld('input', 'Input', 0, 1, 0), fld('time', 'Time', 0, 1, 0.2)],
    outputs: [fld('output', 'Output', 0, 1, 0)],
  },
];

/** The host-fed video source module type (added automatically for media clips). */
export const VIDEO_SOURCE_TYPE = 'source.video.file';

const BY_TYPE = new Map(EFFECT_CATALOG.map((e) => [e.type, e]));

/**
 * Solid stand-in used as the first chain entry when a chain has no generator —
 * a real core source (renders solid, default black) so testonly is never loaded.
 */
export const IMPLICIT_ANCHOR = { type: 'source.solid_color', bundle: CORE };

export function catalogEffect(type: string): CatalogEffect | undefined {
  return BY_TYPE.get(type);
}

export function isCatalogEffect(type: string): boolean {
  return BY_TYPE.has(type);
}

/** Default field state for an effect (field key → default value). */
export function defaultStateFor(type: string): Record<string, number> {
  const e = BY_TYPE.get(type);
  const state: Record<string, number> = {};
  if (e) for (const f of e.fields) state[f.key] = f.default;
  return state;
}

export const GENERATORS = EFFECT_CATALOG.filter((e) => e.role === 'generator');
export const EFFECTS = EFFECT_CATALOG.filter((e) => e.role === 'effect');
