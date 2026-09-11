/**
 * The editor's `WireConvert` vocabulary vs the executor's.
 *
 * There is no TS twin of the conversion MATH to replay — the web runs
 * native/src/sketch/rail_convert.h itself, through executor.wasm — so the only
 * thing that can drift across the boundary is the set of mode NAMES. A mode
 * added to the C++ enum but not to this union is un-selectable in the UI; one
 * added here but not there silently falls back to `auto` at runtime. Neither
 * shows up as a failure anywhere else.
 *
 * The shared fixture (web/test/fixtures/rail-convert-cases.json) is the
 * arbiter: native/tests/test_rail_convert.cpp replays its math, this replays
 * its vocabulary.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { WireConvert } from '../sketch-types';

const FIXTURE = JSON.parse(readFileSync(
  fileURLToPath(new URL('../../test/fixtures/rail-convert-cases.json', import.meta.url)),
  'utf-8')) as { cases: Array<{ name: string; convert?: string }> };

/** Every mode the editor can put on a wire. */
const MODES: WireConvert[] = ['auto', 'broadcast', 'truncate', 'pad'];

describe('wire convert vocabulary', () => {
  it('every mode the fixture exercises is selectable in the editor', () => {
    const used = new Set(FIXTURE.cases.map((c) => c.convert ?? 'auto'));
    for (const mode of used) {
      expect(MODES, `fixture case uses "${mode}"`).toContain(mode);
    }
  });

  it('every selectable mode is exercised by the fixture', () => {
    const used = new Set(FIXTURE.cases.map((c) => c.convert ?? 'auto'));
    for (const mode of MODES) {
      expect(used, `no fixture case covers "${mode}"`).toContain(mode);
    }
  });

  it('an omitted convert means auto', () => {
    // The fixture leans on this: most cases omit the key entirely.
    expect(FIXTURE.cases.some((c) => c.convert === undefined)).toBe(true);
  });
});
