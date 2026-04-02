import { describe, it, expect } from 'vitest';
import * as resolume from './fake-resolume';

describe('fake-resolume', () => {
  it('has 4 clips', () => {
    expect(resolume.getClipCount()).toBe(4);
  });

  it('clips are assigned to channels 0-3', () => {
    expect(resolume.getClipChannel(0)).toBe(0);
    expect(resolume.getClipChannel(1)).toBe(1);
    expect(resolume.getClipChannel(2)).toBe(2);
    expect(resolume.getClipChannel(3)).toBe(3);
  });

  it('out of bounds returns -1 channel', () => {
    expect(resolume.getClipChannel(-1)).toBe(-1);
    expect(resolume.getClipChannel(99)).toBe(-1);
  });

  it('clips have names', () => {
    expect(resolume.getClipName(0)).toBe('Clip A');
    expect(resolume.getClipName(1)).toBe('Clip B');
    expect(resolume.getClipName(2)).toBe('Clip C');
    expect(resolume.getClipName(3)).toBe('Clip D');
  });

  it('out of bounds name returns empty', () => {
    expect(resolume.getClipName(99)).toBe('');
  });

  it('clips are connected', () => {
    for (let i = 0; i < 4; i++) {
      expect(resolume.getClipConnected(i)).toBe(1);
    }
  });

  it('clip IDs are bigints', () => {
    expect(resolume.getClipId(0)).toBe(100n);
    expect(resolume.getClipId(3)).toBe(103n);
  });

  it('BPM is 120', () => {
    expect(resolume.getBpm()).toBe(120);
  });
});
