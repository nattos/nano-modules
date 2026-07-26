/**
 * Composition-document builders for the dual-backend comp scenarios.
 *
 * The store's `addTrack`/`createEmptyClip`/`addClipDeviceType` API can't be used
 * here: the scenario runners deliberately keep the store out of the parity path
 * (the native runner has no store at all), so documents are authored as literal
 * JSON. These builders are the TS twin of the `mkDevice`/`mkClip`/`mkTrack`/
 * `mkComposition` helpers in `native/tests/test_comp_render.cpp` — same shapes,
 * same defaults, so a fixture reads the same on both sides.
 *
 * Field names and defaults follow `src/views/arrangement/model/composition.ts`;
 * `emptyComposition()` is the reference for the meta/rails/playMode block.
 */

export type Json = Record<string, any>;

export function mkDevice(id: string, moduleType: string, state: Json = {}): Json {
  return { id, moduleType, name: moduleType, capabilities: [], state };
}

export function mkClip(
  id: string,
  startBeat: number,
  lengthBeat: number,
  devices: Json[],
  over: Json = {},
): Json {
  return {
    id,
    name: id,
    startBeat,
    lengthBeat,
    kind: 'effect',
    sketch: { devices },
    loop: { mode: 'time', startSec: 0, speed: 1, direction: 'forward' },
    automation: [],
    exports: [],
    reads: [],
    warps: [],
    ...over,
  };
}

export function mkTrack(id: string, clips: Json[], over: Json = {}): Json {
  return {
    id,
    name: id,
    kind: 'track',
    parentId: null,
    sketch: { devices: [] },
    automation: [],
    clips,
    ...over,
  };
}

/**
 * A return/rail track. Rests at 0 — unsigned reads take that as the floor
 * (writers add up from it), signed as the centre; a 0.5 default would both
 * centre the lane at rest and clip on +add. Mirrors `store.addReturn()`.
 */
export function mkRailTrack(id: string, railId: string, over: Json = {}): Json {
  return {
    id,
    name: 'Return',
    kind: 'rail',
    parentId: null,
    sketch: { devices: [] },
    automation: [],
    clips: [],
    railId,
    baseCurve: [{ x: 0, y: 0 }, { x: 1, y: 0 }],
    ...over,
  };
}

/** The main bus every composition carries, appended last. */
export function mainBusTrack(): Json {
  return {
    id: 'main-bus',
    name: 'Main Bus',
    kind: 'group',
    parentId: null,
    sketch: { devices: [] },
    automation: [],
    clips: [],
  };
}

export function mkComposition(tracks: Json[], over: Json = {}): Json {
  return {
    meta: {
      resolution: { width: 1920, height: 1080 },
      baseBPM: 120,
      timeSignature: [4, 4],
    },
    tracks: [...tracks, mainBusTrack()],
    rails: [],
    playMode: { defaultMode: 'time' },
    ...over,
  };
}

/** A modulation a clip writes onto a rail. */
export function mkExport(
  id: string, railId: string, sourceDeviceId: string, sourceField: string,
  over: Json = {},
): Json {
  return { id, railId, sourceDeviceId, sourceField, combine: 'add', magnitude: 'auto', ...over };
}

/** A modulation a clip reads FROM a rail into one of its fields. */
export function mkRead(
  id: string, railId: string, targetDeviceId: string, targetField: string,
  over: Json = {},
): Json {
  return { id, railId, targetDeviceId, targetField, combine: 'replace', magnitude: 'auto', ...over };
}

/** Composition-param target sentinel (lock-step: comp_model.h kLayerTargetId). */
export const LAYER_TARGET_ID = '__layer__';

// ── Canonical fixtures shared by the ported suites ─────────────────────────

/**
 * An LFO at 1 Hz.
 *
 * `rate` is NORMALIZED 0..1 mapping to 0..10 Hz (env_lfo/main.cpp:219), not a
 * frequency — so the obvious-looking `rate: 2` clamps to 1 and runs at **10 Hz**.
 * Under the old wall-clock sampling that merely looked noisy; under fixed-step
 * sampling it ALIASES: 10 Hz sampled every 6 frames (0.1 s) hits the same phase
 * every time and the frame is perfectly constant — indistinguishable from a
 * pinned rail, which is the exact bug these fixtures exist to catch. Keep the
 * period comfortably longer than the sample interval.
 *
 * Measured through the fixed-step runner, sampling every 6 frames (0.1 s):
 * 10 Hz and 5 Hz both read a spread of **0**; 2 Hz and 1 Hz read 255.
 */
export const LFO_1HZ = { rate: 0.1, amplitude: 1 };

/**
 * The arrangement-comp-mode scenario: three tracks, all time-independent so the
 * pixels are stable.
 *   top    = solid_color [0.2, 0.4, 0.8]
 *   middle = solid_color [1, 0, 0], track level 0.5 (composite.blend opacity)
 *   bottom = effect-only clip (color.invert) processing the composite above
 */
export function layeredCompositeDoc(): Json {
  return mkComposition([
    mkTrack('t-top', [mkClip('c-top', 40, 8, [
      mkDevice('d-top', 'source.solid_color', { color: [0.2, 0.4, 0.8] }),
    ])]),
    mkTrack('t-mid', [mkClip('c-mid', 40, 8, [
      mkDevice('d-mid', 'source.solid_color', { color: [1, 0, 0] }),
    ])], { level: 0.5 }),
    mkTrack('t-bot', [mkClip('c-bot', 40, 8, [
      mkDevice('d-bot', 'color.invert'),
    ])]),
  ]);
}

/**
 * A white clip whose brightness is driven by an LFO through a return rail —
 * the read-wire path. The regression this pins: the arrangement re-asserts each
 * rail's BASE via per-frame automation (combine replace), and the executor used
 * to apply that AFTER the wire fold on the same field, clobbering the writer
 * every frame. Rails sat pinned at base and read wires never moved their
 * targets, so the rendered frame was CONSTANT. A live wire must win.
 *
 * The source is MID-GREY on purpose: brightness swings both ways, and a white
 * source clips the entire positive half of the swing — leaving the test blind
 * to half of what it's measuring.
 */
export function railReadWireDoc(): Json {
  const railId = 'rail-1';
  return mkComposition([
    mkTrack('t-1', [mkClip('c-1', 0, 16, [
      mkDevice('d-solid', 'source.solid_color', { color: [0.5, 0.5, 0.5] }),
      mkDevice('d-lfo', 'mod.source.lfo', LFO_1HZ),
      mkDevice('d-bc', 'color.tone.brightness_contrast'),
    ], {
      exports: [mkExport('e1', railId, 'd-lfo', 'output')],
      reads: [mkRead('r1', railId, 'd-bc', 'brightness')],
    })]),
    mkRailTrack('t-rail', railId),
  ]);
}

/** A scene track (`kind: 'scene'`) — its clips are launchable cells, not
 *  timeline content. Mirrors `store.addSceneTrack()`. */
export function mkSceneTrack(id: string, clips: Json[], over: Json = {}): Json {
  return {
    id,
    name: 'Scenes',
    kind: 'scene',
    parentId: null,
    level: 1,
    sketch: { devices: [] },
    automation: [],
    clips,
    ...over,
  };
}

/**
 * A dim-blue base layer plus a scene track holding a RED and a GREEN scene.
 * The base keeps the composite meaningful while no scene plays — with an empty
 * composite there is nothing to assert about.
 *
 * Scenes are rigid one-bar cells and auto channels follow GRID order, so the
 * two live at distinct grid spots (bar 1 and bar 2).
 */
export function sceneTrackDoc(): Json {
  return mkComposition([
    mkTrack('t-base', [mkClip('c-base', 40, 8, [
      mkDevice('d-base', 'source.solid_color', { color: [0, 0, 0.3] }),
    ])]),
    mkSceneTrack('t-scenes', [
      mkClip('s-red', 0, 4, [mkDevice('d-red', 'source.solid_color', { color: [1, 0, 0] })]),
      mkClip('s-green', 4, 4, [mkDevice('d-green', 'source.solid_color', { color: [0, 1, 0] })]),
    ]),
  ]);
}

/**
 * A noise generator on the top track, and an effect-only invert clip on the
 * track BELOW it. The invert must process the noise coming from above — a gray
 * stand-in (the failure mode) is a flat fill, so the composite's luma spread
 * collapses to ~0.
 */
export function layerPipelineDoc(): Json {
  return mkComposition([
    mkTrack('t-noise', [mkClip('c-noise', 40, 8, [
      mkDevice('d-noise', 'source.noise'),
    ])]),
    mkTrack('t-invert', [mkClip('c-invert', 40, 8, [
      mkDevice('d-invert', 'color.invert'),
    ])]),
  ]);
}

/**
 * One automation lane ramping a clip's brightness across its own span. Lane `x`
 * is normalized over the CLIP's beat range, `y` over the field's declared range
 * — so sampling near the clip start vs its end must differ. This is the
 * DOCUMENT automation path (evaluated by comp_eval on both backends), not the
 * executor's per-frame `setAutomation` side channel, which is web-host-only.
 */
export function automationRampDoc(): Json {
  return mkComposition([
    mkTrack('t-1', [mkClip('c-1', 0, 16, [
      mkDevice('d-solid', 'source.solid_color', { color: [0.5, 0.5, 0.5] }),
      mkDevice('d-bc', 'color.tone.brightness_contrast'),
    ], {
      automation: [{
        id: 'lane-1',
        targetDeviceId: 'd-bc',
        targetField: 'brightness',
        label: 'Brightness',
        points: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
        combine: 'replace',
        magnitude: 'unsigned',
      }],
    })]),
  ]);
}

/**
 * The same ramp, but on a TRACK-level FX device (the per-track bus) rather than
 * inside the clip — the `track_<id>_<dev>` keyed path.
 */
export function trackFxAutomationDoc(): Json {
  return mkComposition([
    mkTrack('t-1', [mkClip('c-1', 0, 16, [
      mkDevice('d-solid', 'source.solid_color', { color: [0.5, 0.5, 0.5] }),
    ])], {
      sketch: { devices: [mkDevice('d-trackbc', 'color.tone.brightness_contrast')] },
      automation: [{
        id: 'lane-t',
        targetDeviceId: 'd-trackbc',
        targetField: 'brightness',
        label: 'Brightness',
        points: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
        combine: 'replace',
        magnitude: 'unsigned',
      }],
    }),
  ]);
}

/**
 * An LFO on one track exporting to a return rail, and ANOTHER track's
 * TRACK-LEVEL read (targetDeviceId `__layer__`) driving that track's layer
 * OPACITY — resolved comp-side to the layer's blend `opacity` param. The white
 * layer fades against the black backdrop as the LFO sweeps.
 */
export function layerOpacityRailDoc(): Json {
  const railId = 'rail-op';
  return mkComposition([
    mkTrack('t-white', [mkClip('c-white', 0, 16, [
      mkDevice('d-white', 'source.solid_color', { color: [1, 1, 1] }),
    ])], {
      reads: [mkRead('r-op', railId, LAYER_TARGET_ID, 'opacity')],
    }),
    mkTrack('t-lfo', [mkClip('c-lfo', 0, 16, [
      mkDevice('d-lfo2', 'mod.source.lfo', LFO_1HZ),
    ], {
      exports: [mkExport('e-op', railId, 'd-lfo2', 'output')],
    })]),
    mkRailTrack('t-rail-op', railId),
  ]);
}
