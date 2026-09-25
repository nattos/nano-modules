/**
 * Effect state migrations. The cases live in
 * web/test/fixtures/effect-migration-cases.json, which
 * native/tests/test_effect_migrations.cpp reads too — the shared file is what
 * keeps the TS/C++ twins from drifting.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ALL_MIGRATION_IDS, migrateDeviceState, migrateInstance, migrateInstances,
} from './effect-migrations';
import { normalizeSketchChains, type Sketch } from '../sketch-types';

const FIXTURE = JSON.parse(readFileSync(
  fileURLToPath(new URL('../../test/fixtures/effect-migration-cases.json', import.meta.url)),
  'utf-8')) as { cases: Array<{ name: string; instance: any; expected: any }> };

describe('effect migrations (shared cases)', () => {
  for (const c of FIXTURE.cases) {
    it(c.name, () => {
      const input = structuredClone(c.instance);
      const out = migrateInstance(input);
      expect(out).toEqual(c.expected);
      expect(input).toEqual(c.instance);            // never mutates its input
      expect(migrateInstance(out)).toBe(out);       // idempotent: same object
    });
  }
});

describe('effect migrations on ingest', () => {
  it('normalizeSketchChains migrates a legacy LFO and leaves a clean sketch alone', () => {
    const sketch: Sketch = {
      anchor: null,
      chain: [{ type: 'module', module_type: 'mod.source.lfo', instance_key: 'l' } as any],
      wires: [],
      instances: { l: { module_type: 'mod.source.lfo', state: { rate: 0.3 } } as any },
    } as any;
    const once = normalizeSketchChains(sketch);
    expect((once.instances as any).l.state.rate).toBeCloseTo(3);
    const twice = normalizeSketchChains(once);
    expect(twice.instances).toBe(once.instances);
  });

  it('migrateInstances keeps the map identity when nothing applies', () => {
    const m = { a: { module_type: 'color.tone.brightness_contrast', state: {} } };
    expect(migrateInstances(m)).toBe(m);
  });

  it('an arrangement device migrates only for migrations its composition lacks', () => {
    const st = { rate: 0.5 };
    expect(migrateDeviceState('mod.source.lfo', st, new Set(ALL_MIGRATION_IDS))).toEqual({ rate: 5 });
    expect(migrateDeviceState('mod.source.lfo', st, new Set())).toBe(st);
    expect(migrateDeviceState('mod.source.time', st, new Set(ALL_MIGRATION_IDS))).toBe(st);
  });
});
