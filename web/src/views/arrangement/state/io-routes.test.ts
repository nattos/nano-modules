import { describe, it, expect, beforeEach } from 'vitest';
import { store } from './store';
import type { Track, RouteEnd } from '../model/composition';
import { PORT_IN, PORT_OUT, routeIsLegal } from '../model/composition';
import { seedTestPlugins } from '../engine/test-plugins';

seedTestPlugins();

/**
 * Composition I/O store rules: ports are hubs (routeIsLegal), one route per
 * destination except per-clip feeds into a named out port, deletes prune
 * their routes in the same undo step.
 */
describe('Composition I/O routes', () => {
  let a: Track;
  let b: Track;

  beforeEach(() => {
    while (store.composition.tracks.filter((t) => t.kind === 'track').length < 2) store.addTrack();
    for (const t of store.composition.tracks) {
      if (t.kind !== 'track') continue;
      t.clips = []; t.sketch.devices = []; t.sketch.wires = []; t.ports = undefined; t.output = undefined;
    }
    store.composition.routes = undefined;
    [a, b] = store.composition.tracks.filter((t) => t.kind === 'track');
  });

  const port = (t: Track, p: string): RouteEnd => ({ kind: 'port', trackId: t.id, portId: p });
  const trackField = (t: Track, deviceId: string, field: string): RouteEnd =>
    ({ kind: 'field', trackId: t.id, deviceId, field });

  it('refuses illegal shapes', () => {
    const dev = store.insertTrackDeviceAt(b.id, 0, 'color.hsl')!;
    const c = store.composition;
    expect(routeIsLegal(c, { src: trackField(a, 'x', 'tex_out'), dest: trackField(b, dev, 'tex_b') })).toBe(false);
    expect(routeIsLegal(c, { src: port(a, PORT_OUT), dest: port(b, PORT_OUT) })).toBe(false);
    expect(routeIsLegal(c, { src: port(a, PORT_IN), dest: trackField(b, dev, 'tex_b') })).toBe(false);
    expect(routeIsLegal(c, { src: port(a, PORT_OUT), dest: port(a, PORT_IN) })).toBe(false);
    expect(store.addRoute(trackField(a, 'x', 'tex_out'), trackField(b, dev, 'tex_b'))).toBeNull();
    expect(store.composition.routes ?? []).toHaveLength(0);
  });

  it('a send replaces whatever already fed that destination', () => {
    const dev = store.insertTrackDeviceAt(b.id, 0, 'color.hsl')!;
    const r1 = store.addRoute(port(a, PORT_OUT), trackField(b, dev, 'tex_b'));
    expect(r1).not.toBeNull();
    const out2 = store.addTrackPort(a.id, 'out')!;
    const r2 = store.addRoute(port(a, out2), trackField(b, dev, 'tex_b'));
    const routes = store.composition.routes!;
    expect(routes.map((r) => r.id)).toEqual([r2]);
  });

  it('a named out port keeps one feed per clip', () => {
    const outP = store.addTrackPort(a.id, 'out', 'Left')!;
    const c1 = store.createEmptyClip(a.id, 0, 4)!.split('/')[2];
    const c2 = store.createEmptyClip(a.id, 8, 4)!.split('/')[2];
    store.addClipDeviceType(a.id, c1, 'color.hsl');
    store.addClipDeviceType(a.id, c2, 'color.hsl');
    const d1 = store.composition.tracks.find((t) => t.id === a.id)!.clips.find((c) => c.id === c1)!.sketch.devices[0].id;
    const d2 = store.composition.tracks.find((t) => t.id === a.id)!.clips.find((c) => c.id === c2)!.sketch.devices[0].id;
    store.addRoute({ kind: 'field', trackId: a.id, clipId: c1, deviceId: d1, field: 'tex_out' }, port(a, outP));
    store.addRoute({ kind: 'field', trackId: a.id, clipId: c2, deviceId: d2, field: 'tex_out' }, port(a, outP));
    expect(store.composition.routes).toHaveLength(2);
    // A second feed from the SAME clip replaces its first.
    store.addRoute({ kind: 'field', trackId: a.id, clipId: c1, deviceId: d1, field: 'left_out' }, port(a, outP));
    expect(store.composition.routes).toHaveLength(2);
  });

  it('deleting a device, a port, or a track prunes its routes — undoably', () => {
    const dev = store.insertTrackDeviceAt(b.id, 0, 'color.hsl')!;
    store.addRoute(port(a, PORT_OUT), trackField(b, dev, 'tex_b'));
    expect(store.composition.routes).toHaveLength(1);
    store.removeTrackDevice(b.id, dev);
    expect(store.composition.routes ?? []).toHaveLength(0);
    store.undo();
    expect(store.composition.routes).toHaveLength(1);

    const outP = store.addTrackPort(a.id, 'out')!;
    const dev2 = store.insertTrackDeviceAt(a.id, 0, 'color.hsl')!;
    store.addRoute(trackField(a, dev2, 'tex_out'), port(a, outP));
    expect(store.composition.routes).toHaveLength(2);
    store.removeTrackPort(a.id, outP);
    expect(store.composition.routes).toHaveLength(1);
  });

  it('connectRoute orients a gesture: fields by their direction, ports out→in', () => {
    const dev = store.insertTrackDeviceAt(b.id, 0, 'color.hsl')!;
    const outP = store.addTrackPort(b.id, 'out')!;
    const tex = { type: 'texture' };
    const portInfo = (t: Track, portId: string, dir: 'in' | 'out') => ({
      sketchId: '', colIdx: -1, chainIdx: -1, fieldPath: '', isOutput: dir === 'out',
      viewportY: 0, schemaDef: null, trackPort: { trackId: t.id, portId, dir } });
    const fieldInfo = (field: string, isOutput: boolean) => ({
      sketchId: `track/${b.id}`, colIdx: 0, chainIdx: 0, fieldPath: field, isOutput,
      viewportY: 0, schemaDef: tex });
    // Field (output) dropped on its own named out port → a FEED, either order.
    expect(store.connectRoute(fieldInfo('tex_out', true), portInfo(b, outP, 'out'))).not.toBeNull();
    const feed = store.composition.routes!.at(-1)!;
    expect(feed.src).toMatchObject({ kind: 'field', deviceId: dev, field: 'tex_out' });
    expect(feed.dest).toEqual({ kind: 'port', trackId: b.id, portId: outP });
    // Port dropped on an input field → a SEND.
    expect(store.connectRoute(portInfo(a, PORT_OUT, 'out'), fieldInfo('tex_b', false))).not.toBeNull();
    expect(store.composition.routes!.at(-1)!.src).toEqual({ kind: 'port', trackId: a.id, portId: PORT_OUT });
    // In onto in: refused.
    expect(store.connectRoute(portInfo(a, PORT_IN, 'in'), portInfo(b, PORT_IN, 'in'))).toBeNull();
    // A scalar field is not a route end.
    expect(store.connectRoute(portInfo(a, PORT_OUT, 'out'),
      { ...fieldInfo('hue', false), schemaDef: { type: 'float' } })).toBeNull();
  });

  it('send nowhere toggles', () => {
    store.setTrackOutputMode(a.id, 'none');
    expect(store.trackOutputMode(a.id)).toBe('none');
    store.setTrackOutputMode(a.id, 'normal');
    expect(store.trackById(a.id)!.output).toBeUndefined();
  });
});
