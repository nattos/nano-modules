/**
 * Unit tests for <smart-input>'s effect completion — focused on the recursive,
 * arbitrary-depth path drill-down (e.g. source/ -> light/ -> chroma_wave).
 */
import { describe, it, expect, vi } from 'vitest';
import './smart-input';
import { SmartInput } from './smart-input';
import type { AvailableEffect } from '../state/types';

function eff(id: string, name: string): AvailableEffect {
  return { id, name, description: '', category: id.split('.')[0], keywords: [] };
}

const EFFECTS: AvailableEffect[] = [
  eff('source.gradient', 'Gradient'),
  eff('source.noise', 'Noise'),
  eff('source.solid_color', 'Solid Color'),
  eff('source.phase_fold', 'Phase Fold'),
  eff('source.light.chroma_wave', 'Chroma Wave'),
  eff('source.light.soft_glow', 'Soft Glow'),
  eff('source.particles.flow_swarm', 'Flow Swarm'),
  eff('color.invert', 'Invert'),
  eff('color.tone.curve', 'Curve'),
  eff('color.tone.levels', 'Levels'),
  eff('composite.blend', 'Blend'),
  eff('filter.blur.gaussian', 'Blur'),
  eff('filter.blur.fast', 'Fast Blur'),
];

function complete(query: string) {
  const el = new SmartInput();
  el.effects = EFFECTS;
  const ctx = { state: { doc: { toString: () => query } } } as any;
  const result = (el as any).completionSource(ctx);
  const opts: any[] = result?.options ?? [];
  return {
    folders: opts.filter(o => o.type === 'namespace').map(o => o.label as string),
    effects: opts.filter(o => o.type !== 'namespace' && o.detail).map(o => o.detail as string),
    raw: opts,
  };
}

describe('smart-input drill-down completion', () => {
  it('lists top-level folders at the empty root', () => {
    const { folders, effects } = complete('');
    expect(folders.sort()).toEqual(['color/', 'composite/', 'filter/', 'source/']);
    // No effect sits directly at the root (every id has a dot), so no leaves.
    expect(effects).toEqual([]);
  });

  it('drills one level: source. shows sub-folders AND every nested effect', () => {
    const { folders, effects } = complete('source.');
    expect(folders.sort()).toEqual(['light/', 'particles/']);
    // Shallower effects sort ahead of deeper ones (immediate leaves first) —
    // check the emitted order before sorting for the membership comparison.
    expect(effects.indexOf('source.gradient'))
      .toBeLessThan(effects.indexOf('source.light.chroma_wave'));
    // Relaxed drill-down: ALL effects under source.* at any depth, not just the
    // immediate leaves — the nested light.* / particles.* effects show too.
    expect([...effects].sort()).toEqual([
      'source.gradient',
      'source.light.chroma_wave',
      'source.light.soft_glow',
      'source.noise',
      'source.particles.flow_swarm',
      'source.phase_fold',
      'source.solid_color',
    ]);
  });

  it('drills two levels: source.light. shows only its effects, no folders', () => {
    const { folders, effects } = complete('source.light.');
    expect(folders).toEqual([]);
    expect(effects.sort()).toEqual([
      'source.light.chroma_wave',
      'source.light.soft_glow',
    ]);
  });

  it('a folder option drills into the full path, not just the leaf segment', () => {
    vi.useFakeTimers(); // apply schedules a re-trigger via setTimeout(startCompletion)
    try {
      const { raw } = complete('source.');
      const light = raw.find(o => o.label === 'light/');
      expect(light).toBeTruthy();
      let inserted = '';
      const view = { dispatch: (tr: any) => { inserted = tr.changes.insert; } } as any;
      light.apply(view, null, 0, 'source.'.length);
      expect(inserted).toBe('source.light.');
    } finally {
      vi.useRealTimers(); // drop the pending startCompletion timer before it fires
    }
  });

  it('filters leaves and folders by the local sub-query', () => {
    const { folders, effects } = complete('source.no');
    expect(folders).toEqual([]); // neither light/ nor particles/ matches "no"
    expect(effects).toEqual(['source.noise']);
  });

  it('search within a prefix reaches into deeper folders', () => {
    const { effects } = complete('source.chr');
    expect(effects).toContain('source.light.chroma_wave');
  });

  it('a full dotted id resolves to its effect (seeds preview / express commit)', () => {
    // The type editor is seeded with the full module id (e.g. when retyping an
    // existing effect); typing it back must resolve to exactly that effect so
    // an express commit bakes in a real id.
    const { effects } = complete('color.tone.curve');
    expect(effects[0]).toBe('color.tone.curve');
  });

  it('root fuzzy search stays flat across all effects', () => {
    const { effects } = complete('blur');
    expect(effects).toContain('filter.blur.gaussian');
    expect(effects).toContain('filter.blur.fast');
  });

  it('typing a partial top namespace offers the folder to drill into', () => {
    const { folders } = complete('sou');
    expect(folders).toContain('source/');
  });

  it('an unknown path falls back to flat search', () => {
    const { raw } = complete('source.bogus.xyz');
    expect(raw.length).toBe(1);
    expect(raw[0].label).toBe('No matching effects');
  });

  it('tags each option with its taxonomy domain for category colouring', () => {
    const { raw } = complete('source.');
    // Sub-folder rows carry the parent domain...
    const light = raw.find(o => o.label === 'light/');
    expect(light.category).toBe('source');
    // ...and leaf-effect rows carry their own domain.
    const gradient = raw.find(o => o.detail === 'source.gradient');
    expect(gradient.category).toBe('source');

    // A flat search across domains tags each row independently.
    const flat = complete('blur');
    const gaussian = flat.raw.find(o => o.detail === 'filter.blur.gaussian');
    expect(gaussian.category).toBe('filter');
  });
});
