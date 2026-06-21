import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture what saveProject writes to IDB without a real IndexedDB.
const puts: any[] = [];
vi.mock('./idb-store', () => ({
  STORE_PROJECTS: 'projects',
  idbPut: (_store: string, value: any) => { puts.push(value); return Promise.resolve(); },
  idbGetAll: () => Promise.resolve([]),
  idbDelete: () => Promise.resolve(),
}));

import { saveProject } from './project-store';
import { ENGINE_VERSION } from '../version';
import type { Sketch } from '../sketch-types';

describe('saveProject version stamping', () => {
  beforeEach(() => { puts.length = 0; });

  it('stamps the current engine version onto the serialized sketch', async () => {
    const sketch: Sketch = { anchor: null, chain: [], wires: [], instances: {} };
    await saveProject('user:x', sketch);
    expect(puts).toHaveLength(1);
    expect(puts[0].sketch.engineVersion).toEqual(ENGINE_VERSION);
  });

  it('overwrites a stale engine version with the current one', async () => {
    const sketch = { anchor: null, chain: [], instances: {}, engineVersion: [0, 9, 9] } as any;
    await saveProject('user:y', sketch);
    expect(puts[0].sketch.engineVersion).toEqual(ENGINE_VERSION);
  });
});
