/**
 * Fake discovered plugins for OFFLINE unit tests.
 *
 * The effect registry (`effect-catalog.ts`) derives roles/fields/outputs from the
 * engine's live `store.enginePlugins`, which is empty in vitest (no engine boots).
 * Tests that build sketches or add devices offline call `seedTestPlugins()` to
 * populate `store.enginePlugins` with a minimal set of `PluginInfo` covering the
 * effect types those tests reference — so `catalogEffect`/`defaultStateFor`/
 * `effectCatalog` resolve exactly as they would against a real booted engine.
 *
 * Each plugin mirrors the real discovered schema shape: a scalar FLOAT field is
 * `{type:'float', io, min, max, default, order}` where io&1 = input, io&2 = output;
 * `capabilities:['generator']` marks a source. Field ranges match the real C++
 * schemas where a test asserts on them (notably the LFO `output` is signed [-1,1]).
 */

import type { PluginInfo } from '../../../engine-types';
import { store } from '../state/store';

interface FieldSpec { key: string; min?: number; max?: number; def?: number; out?: boolean; }

function plugin(id: string, generator: boolean, fields: FieldSpec[]): PluginInfo {
  const schema: Record<string, any> = {};
  fields.forEach((f, i) => {
    schema[f.key] = {
      type: 'float',
      io: f.out ? 6 : 5, // 6 = Output|Primary, 5 = Input|Primary
      min: f.min ?? 0,
      max: f.max ?? 1,
      default: f.def ?? 0,
      order: i,
    };
  });
  // A texture output so it reads like a real image-producing effect (ignored by
  // the float-only registry, but keeps the shape honest).
  schema['tex_out'] = { type: 'texture', io: 6, order: fields.length };
  return {
    key: `${id}@0`,
    id,
    version: '0.0.0',
    params: fields
      .filter((f) => !f.out)
      .map((f, i) => ({ index: i, name: f.key, type: 10, defaultValue: f.def ?? 0, min: f.min ?? 0, max: f.max ?? 1 })),
    io: [],
    schema,
    capabilities: generator ? ['generator'] : [],
  };
}

/** The minimal plugin set the offline arrangement tests reference. */
export const TEST_PLUGINS: PluginInfo[] = [
  plugin('source.solid_color', true, []),
  plugin('source.noise', true, [{ key: 'scale', def: 0.5 }, { key: 'contrast', min: -1, max: 1 }]),
  plugin('source.video.file', true, []),
  plugin('color.invert', false, []),
  plugin('color.saturate', false, [{ key: 'prescale', min: 0, max: 4, def: 1 }]),
  plugin('color.tone.brightness_contrast', false, [
    { key: 'brightness', min: -1, max: 1 }, { key: 'contrast', min: -1, max: 1 },
  ]),
  plugin('color.hsl', false, [
    { key: 'hue_shift', min: -1, max: 1 },
    { key: 'saturation', min: -1, max: 1 },
    { key: 'lightness', min: -1, max: 1 },
  ]),
  plugin('composite.blend', false, [{ key: 'opacity', def: 0.5 }]),
  // Signed [-1,1] modulation source — the rail tests assert srcMin/srcMax = -1/1.
  plugin('mod.source.lfo', false, [
    { key: 'rate', def: 0.5 }, { key: 'amplitude', def: 1 }, { key: 'shape' },
    { key: 'output', min: -1, max: 1, out: true },
  ]),
  // The rail accumulator relay (identity remap).
  plugin('mod.shaper.remap', false, [
    { key: 'input' }, { key: 'in_min', min: -1, max: 1 }, { key: 'in_max', min: -1, max: 1, def: 1 },
    { key: 'out_min', min: -1, max: 1 }, { key: 'out_max', min: -1, max: 1, def: 1 },
    { key: 'output', out: true },
  ]),
];

/** Seed `store.enginePlugins` so the registry resolves offline. Idempotent. */
export function seedTestPlugins(): void {
  store.setEnginePlugins(TEST_PLUGINS);
}
