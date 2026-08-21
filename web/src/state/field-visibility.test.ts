/**
 * Conditional field visibility is PER INSTANCE, not per module type.
 *
 * A schema is published once per module type, so an effect with mode-dependent
 * fields declares the union and hides the inactive ones. The hidden SET,
 * though, belongs to the individual card — and the engine's broadcast schema
 * carries only a type-level, first-host-wins approximation of it. These tests
 * pin the overlay that resolves each card independently, and the memoization
 * that keeps it cheap enough to run inside render.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { runInAction } from 'mobx';
import { appState } from './app-state';
import { ideColumnAdapter } from './ide-column-adapter';
import { applyHidden, hiddenFieldsFor, registerVisibilityRule } from './field-visibility';

const plug = (id: string, schema: Record<string, any>) =>
  ({ id, key: id, name: id, version: '1.0.0', params: [], io: [], schema }) as any;

/** A mode-dependent effect: `alt` is only meaningful while mode is 1. */
const FOLD = plug('source.fold', {
  mode: { type: 'int', io: 1 },
  main: { type: 'float', io: 1 },
  alt: { type: 'float', io: 1 },
});

function seed(plugins: any[], instances: Record<string, any>, live?: Record<string, string[]>) {
  runInAction(() => {
    appState.local.plugins = plugins;
    appState.local.engine.hiddenFields = live ?? {};
    appState.database.sketches = {
      sk: { anchor: null, chain: [], wires: [], instances },
    } as any;
  });
}

describe('applyHidden', () => {
  it('leaves the plugin untouched — same identity — for a null hidden set', () => {
    expect(applyHidden(FOLD, null)).toBe(FOLD);
  });

  it('stamps hidden true on named fields and false on the rest', () => {
    const out = applyHidden(FOLD, ['alt']);
    expect(out.schema!.alt.hidden).toBe(true);
    // Untouched fields keep their original def — only a field whose flag has to
    // FLIP is rewritten, so "not hidden" stays absent rather than becoming false.
    expect(out.schema!.main.hidden).toBeFalsy();
    expect(out.schema!.mode.hidden).toBeFalsy();
  });

  it('OVERRIDES a stale type-level hidden flag rather than only adding to it', () => {
    // The broadcast schema says `alt` is hidden (some other instance of this
    // type is in mode 0). This card is in mode 1 and needs it back.
    const typeLevel = plug('source.fold', {
      mode: { type: 'int', io: 1 },
      main: { type: 'float', io: 1 },
      alt: { type: 'float', io: 1, hidden: true },
    });
    expect(applyHidden(typeLevel, []).schema!.alt.hidden).toBe(false);
  });

  it('preserves identity when the overlay changes nothing', () => {
    const already = plug('x', { a: { type: 'float', io: 1, hidden: true } });
    expect(applyHidden(already, ['a'])).toBe(already);
  });

  it('memoizes, so rendering the same card repeatedly is free and stable', () => {
    const first = applyHidden(FOLD, ['alt']);
    expect(applyHidden(FOLD, ['alt'])).toBe(first);
    // A different set is a different entry, not a cache collision.
    expect(applyHidden(FOLD, ['main'])).not.toBe(first);
  });
});

describe('hiddenFieldsFor', () => {
  beforeEach(() => {
    registerVisibilityRule('test.ruled', (state) => (state.mode === 1 ? [] : ['alt']));
  });

  it('prefers a synchronous rule over the engine\'s live set', () => {
    expect(hiddenFieldsFor('test.ruled', { mode: 1 }, ['alt', 'main'])).toEqual([]);
    expect(hiddenFieldsFor('test.ruled', { mode: 0 }, [])).toEqual(['alt']);
  });

  it('falls back to the live per-instance set when no rule is registered', () => {
    expect(hiddenFieldsFor('test.unruled', {}, ['alt'])).toEqual(['alt']);
    // An EMPTY live set is still an answer ("this instance hides nothing") and
    // must override the schema's type-level flags; only absence declines.
    expect(hiddenFieldsFor('test.unruled', {}, [])).toEqual([]);
    expect(hiddenFieldsFor('test.unruled', {}, null)).toBeNull();
    expect(hiddenFieldsFor('test.unruled', {}, undefined)).toBeNull();
  });

  it('tolerates a missing instance state', () => {
    expect(hiddenFieldsFor('test.ruled', undefined)).toEqual(['alt']);
  });
});

describe('ideColumnAdapter.getPlugin resolves per instance', () => {
  it('gives two cards of ONE module type their own hidden sets', () => {
    // The regression this whole layer exists for: before, both cards read the
    // same type-level flags, so whichever instance executed first decided what
    // the other one showed.
    seed([FOLD], {
      a: { module_type: 'source.fold', state: { mode: 0 } },
      b: { module_type: 'source.fold', state: { mode: 1 } },
    }, { a: ['alt'], b: [] });

    const a = ideColumnAdapter.data.getPlugin('source.fold', 'a');
    const b = ideColumnAdapter.data.getPlugin('source.fold', 'b');
    expect(a!.schema!.alt.hidden).toBe(true);
    // Falsy, not literally `false`: nothing needed changing for b, so the
    // overlay hands back the untouched schema (see the identity test above).
    expect(b!.schema!.alt.hidden).toBeFalsy();
  });

  it('returns the bare type-level plugin, unoverlaid, when no instance key is given', () => {
    seed([FOLD], {});
    const p = ideColumnAdapter.data.getPlugin('source.fold');
    // No overlay ran, so no field gained a `hidden` flag it didn't declare.
    // (Identity is against the observable proxy MobX wraps plugins[] in, not
    // the literal FOLD object, so compare behaviour rather than reference.)
    expect(p!.schema!.alt.hidden).toBeUndefined();
    expect(ideColumnAdapter.data.getPlugin('source.fold')).toBe(p);
  });

  it('resolves from the DOCUMENT, with no live engine entry at all', () => {
    // No `hiddenFields` for this instance — it has never executed. A synchronous
    // rule still answers, which is what keeps the card's first paint correct.
    registerVisibilityRule('test.doconly', (state) => (state.n === 2 ? ['alt'] : []));
    seed([plug('test.doconly', { main: { type: 'float', io: 1 }, alt: { type: 'float', io: 1 } })],
      { z: { module_type: 'test.doconly', state: { n: 2 } } });
    const p = ideColumnAdapter.data.getPlugin('test.doconly', 'z');
    expect(p!.schema!.alt.hidden).toBe(true);
  });
});
