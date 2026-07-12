import { describe, it, expect } from 'vitest';

import { parseBarrelInstances } from './barrel-instances';

const NB = 'com.nano.nanobarrel';

describe('parseBarrelInstances', () => {
  it('prefers the Resolume-derived default_name over the UUID segment', () => {
    const arr = [{
      key: '9B96D63F-FFFC-4477-97B2-78F8E0CE1795',
      metadata: { id: NB },
      resolume: { default_name: 'My Clip', location: '/layers/1/clips/0/video/effects/0' },
    }];
    const out = parseBarrelInstances(arr);
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe('My Clip');
    expect(out[0].resolumeLocation).toBe('/layers/1/clips/0/video/effects/0');
  });

  it('falls back to the first UUID segment when resolume info is absent (playground)', () => {
    const arr = [{ key: 'ABCD1234-xyz', metadata: { id: NB } }];
    const out = parseBarrelInstances(arr);
    expect(out[0].label).toBe('ABCD1234');
    expect(out[0].resolumeLocation).toBeUndefined();
  });

  it('falls back when default_name is blank/whitespace', () => {
    const arr = [{ key: 'ABCD1234-xyz', metadata: { id: NB }, resolume: { default_name: '   ' } }];
    expect(parseBarrelInstances(arr)[0].label).toBe('ABCD1234');
  });

  it('ignores non-nanobarrel entries and non-arrays', () => {
    expect(parseBarrelInstances(null)).toEqual([]);
    expect(parseBarrelInstances([{ key: 'x', metadata: { id: 'com.nano.nanolooper' } }])).toEqual([]);
    expect(parseBarrelInstances([{ metadata: { id: NB } }])).toEqual([]); // no key
  });
});
