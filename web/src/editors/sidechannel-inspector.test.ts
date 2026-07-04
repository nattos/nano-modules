import { describe, it, expect, beforeEach } from 'vitest';
import { runInAction } from 'mobx';
import { appState } from '../state/app-state';
import { sidechannelWriterLabel } from './sidechannel-inspector';

describe('sidechannelWriterLabel', () => {
  beforeEach(() => {
    runInAction(() => {
      appState.local.barrelInstances = [
        { key: 'pg:1234-abcd', id: 'playground', label: 'Instance 2' },
        { key: 'D0C7A9E2-5F31-4B2A-9E1C-77AA00BB11CC', id: 'com.nano.nanobarrel', label: 'D0C7A9E2' },
      ];
    });
  });

  it('resolves a playground sketch id through the instances list', () => {
    expect(sidechannelWriterLabel('pg:1234-abcd')).toBe('Instance 2');
  });

  it('resolves a barrel plugin key through the instances list', () => {
    expect(sidechannelWriterLabel('D0C7A9E2-5F31-4B2A-9E1C-77AA00BB11CC')).toBe('D0C7A9E2');
  });

  it('falls back to the first UUID segment for unknown tags', () => {
    expect(sidechannelWriterLabel('FEEDFACE-1111-2222-3333-444455556666')).toBe('FEEDFACE');
  });

  it('empty tag yields empty label', () => {
    expect(sidechannelWriterLabel('')).toBe('');
  });
});
