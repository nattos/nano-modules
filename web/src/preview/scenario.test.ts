import { describe, it, expect } from 'vitest';
import { compileScenario, GENERATOR_NODE_EFFECT, DEFAULT_CAPTURE_SEC, hashString, scenarioThumb } from './scenario';

describe('compileScenario', () => {
  it('defaults: an image effect runs alone on the motion picture', () => {
    const c = compileScenario('color.tone.brightness_contrast', undefined, 'image', 'p1');
    expect(c.selfKey).toBe('p1:self');
    expect(c.input).toBe('motion');
    expect(c.sketch.chain).toEqual([{ type: 'module', module_type: 'color.tone.brightness_contrast', instance_key: 'p1:self' }]);
    expect(c.sketch.wires).toBeUndefined();
    expect(c.sketch.execOrder).toBeUndefined();
    expect(c.captureSec).toBe(DEFAULT_CAPTURE_SEC);
  });

  it('defaults: generators and modulation effects get no input picture', () => {
    expect(compileScenario('source.noise', undefined, 'generator').input).toBeNull();
    expect(compileScenario('mod.source.lfo', undefined, 'modulation').input).toBeNull();
  });

  it('builds helpers as canvas nodes wired into the previewed effect', () => {
    const json = JSON.stringify({
      v: 1, input: 'motion', params: { opacity: 0.25 },
      aux: [
        { key: 'b', generator: 'edges', params: {} },
        { key: 'lfo', effect: 'mod.source.lfo', params: { rate: 0.5 } },
      ],
      wires: [
        { src: 'b.output', dest: '$self.tex_b' },
        { src: 'lfo.output', dest: '$self.opacity', combine: 'mix', magnitude: 'unsigned' },
      ],
      capture: 2, loop: 3,
    });
    const c = compileScenario('composite.blend', json, 'image', 'p');
    const chain = c.sketch.chain!;
    expect(chain[0]).toEqual({ type: 'module', module_type: 'composite.blend', instance_key: 'p:self' });
    // Helpers sit at the tail, as canvas nodes.
    expect(chain.slice(1).map((e) => [e.instance_key, e.module_type, !!e.canvas])).toEqual([
      ['p:b', GENERATOR_NODE_EFFECT, true],
      ['p:lfo', 'mod.source.lfo', true],
    ]);
    expect(c.instanceGenerators).toEqual({ 'p:b': 'edges' });
    expect(c.sketch.instances!['p:self'].state).toEqual({ opacity: 0.25 });
    expect(c.sketch.instances!['p:lfo'].state).toEqual({ rate: 0.5 });
    // A generator node's output is its tex_out, whatever the scenario named it.
    expect(c.sketch.wires).toEqual([
      { id: 'p:w0', src: { instanceKey: 'p:b', field: 'tex_out' }, dest: { instanceKey: 'p:self', field: 'tex_b' } },
      { id: 'p:w1', src: { instanceKey: 'p:lfo', field: 'output' }, dest: { instanceKey: 'p:self', field: 'opacity' },
        combine: 'mix', magnitude: 'unsigned' },
    ]);
    // The helpers must run before the effect they feed.
    expect(c.sketch.execOrder).toBeDefined();
    const order = c.sketch.execOrder!;
    expect(order.indexOf('p:b')).toBeLessThan(order.indexOf('p:self'));
    expect(order.indexOf('p:lfo')).toBeLessThan(order.indexOf('p:self'));
    expect(c.effects).toEqual(['composite.blend', GENERATOR_NODE_EFFECT, 'mod.source.lfo']);
    expect(c.captureSec).toBe(2);
    expect(c.loopSec).toBe(3);
  });

  it('drops malformed pieces instead of throwing', () => {
    const json = JSON.stringify({
      input: 'no-such-generator',
      params: { a: {}, b: 2, c: null, d: [1, 'x'], e: [1, 2, 3, 4, 5], __enable__: 0 },
      aux: [null, { key: 'bad key!', effect: 'x' }, { key: 'ok' }, { key: 'l', effect: 'mod.source.lfo' }, { key: 'l', effect: 'dup' }],
      wires: [{ src: 'nope.output', dest: '$self.x' }, { src: 'l.output' }, { src: 'l.output', dest: 'l.rate' }, 'junk'],
      capture: -1,
    });
    const c = compileScenario('fx', json, 'image');
    expect(c.input).toBe('motion');  // unknown generator → the default
    expect(c.sketch.instances!['pv:self'].state).toEqual({ b: 2 });
    expect(c.sketch.chain!.map((e) => e.instance_key)).toEqual(['pv:self', 'pv:l']);
    expect(c.sketch.wires).toBeUndefined();
    expect(c.captureSec).toBe(DEFAULT_CAPTURE_SEC);
    expect(compileScenario('fx', '{not json', 'image').input).toBe('motion');
    expect(compileScenario('fx', JSON.stringify({ input: 'none' }), 'image').input).toBeNull();
  });

  it('carries vector + string params, pre stages, plot series and the thumb mode', () => {
    const json = JSON.stringify({
      input: 'motion',
      params: { color: [1, 0.5, 0.25], text: 'Hello "there"', size: 96 },
      pre: [{ key: 'mv', effect: 'debug.motion_rect', params: { speed: 2 } }, { key: 'bad' }],
      aux: [{ key: 'lfo', effect: 'mod.source.lfo' }],
      wires: [{ src: 'lfo.output', dest: 'mv.speed' }],
      plot: ['lfo.output', 'nope.output', 'lfo'],
      output: 'meter',
      thumb: 'icon',
    });
    const c = compileScenario('motion.blur', json, 'image', 'p');
    expect(c.sketch.instances!['p:self'].state).toEqual({ color: [1, 0.5, 0.25], text: 'Hello "there"', size: 96 });
    // The pre stage runs linearly ahead of the effect; helpers still trail.
    expect(c.sketch.chain!.map((e) => [e.instance_key, !!e.canvas])).toEqual([['p:mv', false], ['p:self', false], ['p:lfo', true]]);
    expect(c.sketch.instances!['p:mv']).toEqual({ module_type: 'debug.motion_rect', state: { speed: 2 } });
    expect(c.selfKey).toBe('p:self');
    expect(c.sketch.wires!.map((w) => w.dest)).toEqual([{ instanceKey: 'p:mv', field: 'speed' }]);
    expect(c.plotSeries).toEqual([{ instanceKey: 'p:lfo', field: 'output' }]);
    expect(c.plotOutput).toBe('meter');
    expect(c.thumb).toBe('icon');
    expect(scenarioThumb(json)).toBe('icon');
    expect(scenarioThumb(undefined)).toBe('auto');
    expect(compileScenario('fx', undefined, 'image').thumb).toBe('auto');
  });

  it('stamps instance versions so scenario params are never migrated as legacy', () => {
    const json = JSON.stringify({ aux: [{ key: 'lfo', effect: 'mod.source.lfo', params: { rate: 0.25 } }] });
    const c = compileScenario('fx', json, 'image', 'p', (id) => ({ module: [1, 0, 0], effect: id === 'fx' ? [2, 0, 0] : [1, 2, 0] }));
    expect(c.sketch.instances!['p:self'].version).toEqual({ module: [1, 0, 0], effect: [2, 0, 0] });
    expect(c.sketch.instances!['p:lfo'].version).toEqual({ module: [1, 0, 0], effect: [1, 2, 0] });
    expect(compileScenario('fx', json, 'image').sketch.instances!['pv:lfo'].version).toBeUndefined();
  });

  it('hashString is stable and discriminating', () => {
    expect(hashString('abc')).toBe(hashString('abc'));
    expect(hashString('abc')).not.toBe(hashString('abd'));
    expect(hashString('')).toMatch(/^[0-9a-f]{8}$/);
  });
});
