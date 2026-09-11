import { describe, it, expect, beforeEach } from 'vitest';
import { store, paths } from './store';
import { seedTestPlugins } from '../engine/test-plugins';
seedTestPlugins();
import { ArrColumnAdapter, clipTarget } from '../surfaces/arr-column-adapter';

/**
 * Automation curves on ONE COMPONENT of a vector field.
 *
 * A lane's identity is (device, field, component). Without the component in
 * that key, two curves on one vector field alias — selecting Y would find X's
 * lane, "ensure" would refuse to make a second, and deleting one would clear
 * the other's selection. Each test below is one of those.
 */
describe('per-component automation lanes', () => {
  let trk: string;
  let clip: string;
  let devId: string;
  const owner = () => paths.clip(trk, clip);

  beforeEach(() => {
    store.clearSelection();
    store.selectedAutoField = {};
    trk = store.addTrack();
    clip = store.createEmptyClip(trk, 0, 8)!.split('/')[2];
    store.addClipDeviceType(trk, clip, 'warp.transform');
    devId = store.trackById(trk)!.clips.find((c) => c.id === clip)!.sketch.devices[0].id;
  });

  const lanes = () =>
    store.trackById(trk)!.clips.find((c) => c.id === clip)!.automation;

  it('X and Y are two lanes, not one', () => {
    store.selectAutoField(owner(), devId, 'translate', 0);
    const x = store.ensureSelectedClipLane(trk, clip);
    store.selectAutoField(owner(), devId, 'translate', 1);
    const y = store.ensureSelectedClipLane(trk, clip);

    expect(x).toBeTruthy();
    expect(y).toBeTruthy();
    expect(y).not.toBe(x);
    expect(lanes()).toHaveLength(2);
    expect(lanes().map((l) => l.targetLane).sort()).toEqual([0, 1]);
  });

  it('each selection resolves to its own lane', () => {
    store.selectAutoField(owner(), devId, 'translate', 0);
    const x = store.ensureSelectedClipLane(trk, clip);
    store.selectAutoField(owner(), devId, 'translate', 1);
    const y = store.ensureSelectedClipLane(trk, clip);

    store.selectAutoField(owner(), devId, 'translate', 0);
    expect(store.selectedClipLane(trk, clip)?.id).toBe(x);
    store.selectAutoField(owner(), devId, 'translate', 1);
    expect(store.selectedClipLane(trk, clip)?.id).toBe(y);
  });

  it('a whole-field curve is distinct from either component curve', () => {
    store.selectAutoField(owner(), devId, 'translate');
    const all = store.ensureSelectedClipLane(trk, clip);
    store.selectAutoField(owner(), devId, 'translate', 0);
    const x = store.ensureSelectedClipLane(trk, clip);

    expect(x).not.toBe(all);
    expect(lanes()).toHaveLength(2);
    expect(lanes().find((l) => l.id === all)!.targetLane).toBeUndefined();
  });

  it('deleting one component lane leaves the other selected', () => {
    store.selectAutoField(owner(), devId, 'translate', 0);
    const x = store.ensureSelectedClipLane(trk, clip);
    store.selectAutoField(owner(), devId, 'translate', 1);
    store.ensureSelectedClipLane(trk, clip);

    // Y is selected; removing X must not clear it.
    store.removeAutomationLane(x);
    expect(lanes()).toHaveLength(1);
    expect(store.autoField(owner())?.lane).toBe(1);
    expect(store.selectedClipLane(trk, clip)).toBeDefined();
  });

  it('labels name the component, since a lane label is frozen at creation', () => {
    store.selectAutoField(owner(), devId, 'translate', 0);
    expect(store.autoField(owner())!.label).toMatch(/translate X$/);
    store.selectAutoField(owner(), devId, 'translate', 1);
    expect(store.autoField(owner())!.label).toMatch(/translate Y$/);
    store.selectAutoField(owner(), devId, 'translate');
    expect(store.autoField(owner())!.label).toMatch(/translate$/);
  });

  it('a colour names its channels R/G/B rather than X/Y/Z', () => {
    store.addClipDeviceType(trk, clip, 'source.solid_color');
    const devs = store.trackById(trk)!.clips.find((c) => c.id === clip)!.sketch.devices;
    const colId = devs.find((d) => d.moduleType === 'source.solid_color')!.id;
    store.selectAutoField(owner(), colId, 'color', 2);
    expect(store.autoField(owner())!.label).toMatch(/color B$/);
  });

  it('the field-click round-trip preserves the component', () => {
    // selectField parses an anchor path; selectedFieldKey rebuilds one. If the
    // two disagree a per-component curve loses its highlight the moment it is
    // selected.
    const adapter = new ArrColumnAdapter(clipTarget(trk, clip));
    const key = `${owner()}/0/0/translate#1`;
    adapter.controller.selectField!(key);
    expect(store.autoField(owner())).toMatchObject({ field: 'translate', lane: 1 });
    expect(adapter.controller.selectedFieldKey!()).toBe(key);
  });

  it('a whole-field click round-trips with no component', () => {
    const adapter = new ArrColumnAdapter(clipTarget(trk, clip));
    const key = `${owner()}/0/0/translate`;
    adapter.controller.selectField!(key);
    expect(store.autoField(owner())?.lane).toBeUndefined();
    expect(adapter.controller.selectedFieldKey!()).toBe(key);
  });
});
