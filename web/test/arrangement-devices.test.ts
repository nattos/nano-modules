/**
 * GPU e2e: MIDI devices in the arrangement, on both comp engines.
 *
 * A MIDI control wired to a field drives it through the composition — the
 * worker engine gets the lowered value table, the native compositor gets the
 * on-screen simulation over the bridge and merges it in its own MIDI host.
 * No placement is needed; a placement only puts the device on the timeline
 * as a row. The Devices view (Remote Control's panel) takes the main area;
 * mid-wire, hovering the Timeline / Devices switch flips it.
 *
 *   GPU_TEST_BASE_URL=http://localhost:5173 npx jest -i arrangement-devices
 */

import { CENTER, sampleMonitor, waitForMonitor } from './arr-test-helpers';

import { arrangementUrl, forEachCompBackend } from './comp-backend';

const BASE = process.env.GPU_TEST_BASE_URL || process.env.ARR_BASE_URL || 'http://localhost:5173';
let URL = '';

/** Reset to one empty clipless track holding `devices` (moduleType, state),
 *  with no device placements; returns the track id + device ids. */
async function resetTrack(devices: [string, Record<string, unknown>][]) {
  return page.evaluate((devs: [string, Record<string, unknown>][]) => {
    const store = (window as any).arrangementStore;
    while (store.composition.tracks.filter((t: any) => t.kind === 'track').length < 1) store.addTrack();
    for (const t of store.composition.tracks) {
      if (t.kind !== 'track') continue;
      t.clips = []; t.sketch.devices = []; t.sketch.wires = [];
      t.bypassed = false; t.soloed = false; t.level = undefined; t.blendMode = undefined;
      t.ports = undefined; t.output = undefined;
    }
    store.composition.routes = [];
    store.composition.devices = undefined;
    store.positionBeat = 16;
    const t = store.composition.tracks.find((x: any) => x.kind === 'track');
    const ids: string[] = [];
    devs.forEach(([type, state], i) => {
      const id = store.insertTrackDeviceAt(t.id, i, type);
      for (const [k, v] of Object.entries(state)) store.setTrackDeviceField(t.id, id, k, v);
      ids.push(id);
    });
    return { track: t.id as string, ids };
  }, devices);
}

/** A library MFT (made from the template), not yet in the show. */
async function makeDevice(): Promise<string> {
  return page.evaluate(() => {
    const mc = (window as any).midiController;
    return mc.ensureInstanceForEdit('com.nano.midi.mft').id as string;
  });
}

async function setKnob(deviceId: string, endpoint: string, value: number | null) {
  await page.evaluate((id: string, ep: string, v: number | null) => {
    (window as any).midiController.manager.setSimulatedValue(id, ep, v);
  }, deviceId, endpoint, value);
}

const centre = async () => (await sampleMonitor(page, [CENTER]))?.[0];

async function deepCentre(sel: string): Promise<{ x: number; y: number } | null> {
  return page.evaluate((selector: string) => {
    const stack: (Document | ShadowRoot)[] = [document];
    while (stack.length) {
      const root = stack.pop()!;
      const hit = root.querySelector(selector) as HTMLElement | null;
      if (hit) {
        const r = hit.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
      for (const el of root.querySelectorAll('*')) {
        if ((el as HTMLElement).shadowRoot) stack.push((el as HTMLElement).shadowRoot!);
      }
    }
    return null;
  }, sel);
}

async function deepCount(sel: string): Promise<number> {
  return page.evaluate((selector: string) => {
    let n = 0;
    const stack: (Document | ShadowRoot)[] = [document];
    while (stack.length) {
      const root = stack.pop()!;
      n += root.querySelectorAll(selector).length;
      for (const el of root.querySelectorAll('*')) {
        if ((el as HTMLElement).shadowRoot) stack.push((el as HTMLElement).shadowRoot!);
      }
    }
    return n;
  }, sel);
}

async function drag(from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / 8, from.y + ((to.y - from.y) * i) / 8);
  }
  await new Promise((r) => setTimeout(r, 60));
  await page.mouse.up();
}

forEachCompBackend(() => {
beforeAll(() => { URL = arrangementUrl(BASE); });

describe('Arrangement MIDI devices (GPU)', () => {
  jest.setTimeout(60_000);

  beforeAll(async () => {
    await page.setViewport({ width: 1600, height: 1000 });
    await page.goto(URL, { waitUntil: 'networkidle0' });
    await page.waitForFunction(
      () => !!(window as any).arrangementStore && !!(window as any).midiController
        && !!customElements.get('arrangement-app'),
      { timeout: 20_000 },
    );
  });

  it('a knob on a track’s opacity drives the picture, with no placement', async () => {
    const { track } = await resetTrack([['source.solid_color', { color: [1, 1, 1] }]]);
    const dev = await makeDevice();
    await page.evaluate((trackId: string, deviceId: string) => {
      const store = (window as any).arrangementStore;
      store.connectSketchWire(
        { sketchId: '', colIdx: -1, chainIdx: -1, fieldPath: '', isOutput: true, viewportY: 0,
          schemaDef: null, deviceControl: { deviceInstanceId: deviceId, controlId: 'b0/e00/turn' } },
        { sketchId: '', colIdx: -1, chainIdx: -1, fieldPath: '', isOutput: false, viewportY: 0,
          schemaDef: null, layerOwner: trackId, layerField: 'opacity' });
    }, track, dev);
    expect(await page.evaluate(() => (window as any).arrangementStore.devicePlacements.length)).toBe(0);

    await setKnob(dev, 'b0/e00/turn', 0);
    await waitForMonitor(page, [CENTER], ([s]) => s.r < 30 && s.g < 30 && s.b < 30);
    await setKnob(dev, 'b0/e00/turn', 1);
    await waitForMonitor(page, [CENTER], ([s]) => s.r > 200 && s.g > 200);
    await setKnob(dev, 'b0/e00/turn', 0);
    await waitForMonitor(page, [CENTER], ([s]) => s.r < 30);
    await setKnob(dev, 'b0/e00/turn', null);
  });

  it('W mode: a control in the device row drags onto an inspector field', async () => {
    const { track } = await resetTrack([
      ['source.solid_color', { color: [0.25, 0.25, 0.25] }],
      ['color.hsl', {}],
    ]);
    const dev = await makeDevice();
    await page.evaluate((trackId: string, deviceId: string) => {
      const store = (window as any).arrangementStore;
      store.includeDevice(deviceId);
      store.setMainView('timeline');
      if (!store.wiresMode) store.toggleWiresMode();
      store.setSelection([`track/${trackId}`]);
    }, track, dev);
    await page.waitForFunction(() => {
      const stack: (Document | ShadowRoot)[] = [document];
      while (stack.length) {
        const root = stack.pop()!;
        if (root.querySelector('.tap-overlay-hit[data-field-path="lightness"]')
            && document.querySelector('arrangement-app')) return true;
        for (const el of root.querySelectorAll('*')) if ((el as HTMLElement).shadowRoot) stack.push((el as HTMLElement).shadowRoot!);
      }
      return false;
    }, { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 300));

    // The row's controls wear the output mask, carrying the connect dataset.
    const knobSel = `.tap-overlay-hit.output[data-device-instance="${dev}"][data-device-control="b0/e00/turn"]`;
    expect(await deepCount(knobSel)).toBe(1);
    const knob = await deepCentre(knobSel);
    const light = await deepCentre('.tap-overlay-hit[data-field-path="lightness"]');
    expect(knob).not.toBeNull();
    expect(light).not.toBeNull();
    // The dial's RING is `turn`; its centre disc is `press`.
    await drag({ x: knob!.x - 13, y: knob!.y }, light!);
    const wires = await page.evaluate((trackId: string) => JSON.parse(JSON.stringify(
      (window as any).arrangementStore.composition.tracks.find((t: any) => t.id === trackId).sketch.wires)), track);
    expect(wires).toHaveLength(1);
    expect(wires[0].src).toEqual({ instanceKey: `midi:${dev}`, field: 'b0/e00/turn' });
    expect(wires[0].dest.field).toBe('lightness');
    // The overlay draws it from the control to the field.
    await page.waitForFunction(() => {
      const stack: (Document | ShadowRoot)[] = [document];
      while (stack.length) {
        const root = stack.pop()!;
        const ov = root.querySelector('arr-overlay');
        if (ov) return !!ov.shadowRoot!.querySelector('path.arc.midi');
        for (const el of root.querySelectorAll('*')) if ((el as HTMLElement).shadowRoot) stack.push((el as HTMLElement).shadowRoot!);
      }
      return false;
    }, { timeout: 5_000 });

    // And it drives the picture: the knob up brightens the grey.
    await setKnob(dev, 'b0/e00/turn', 0);
    await waitForMonitor(page, [CENTER], ([s]) => s.r > 40 && s.r < 90);
    const dim = (await centre())!.r;
    await setKnob(dev, 'b0/e00/turn', 1);
    await waitForMonitor(page, [CENTER], ([s]) => s.r > dim + 40);
    await setKnob(dev, 'b0/e00/turn', null);

    // Taking the device off the timeline removes its row, not its wire.
    await page.evaluate(() => {
      const store = (window as any).arrangementStore;
      store.removeDevicePlacement(store.devicePlacements[0].id);
    });
    expect(await page.evaluate((trackId: string) =>
      ((window as any).arrangementStore.composition.tracks.find((t: any) => t.id === trackId).sketch.wires ?? []).length,
    track)).toBe(1);
    expect(await deepCount(knobSel)).toBe(0);
  });

  it('the Devices view: in-use filter, drag a control to a field, the timeline toggle', async () => {
    const { track } = await resetTrack([
      ['source.solid_color', { color: [0.25, 0.25, 0.25] }],
      ['color.hsl', {}],
    ]);
    const dev = await makeDevice();
    const other = await makeDevice();
    await page.evaluate((trackId: string) => {
      const store = (window as any).arrangementStore;
      if (!store.wiresMode) store.toggleWiresMode();
      store.setDeviceFilters({ ...store.deviceFilters, inUse: false });
      store.setSelection([`track/${trackId}`]);
    }, track);
    // The switch in the top bar shows the panel in the main area.
    const sw = await deepCentre('[data-main-view="devices"]');
    expect(sw).not.toBeNull();
    await page.mouse.click(sw!.x, sw!.y);
    expect(await page.evaluate(() => (window as any).arrangementStore.mainView)).toBe('devices');
    const surfSel = (id: string, ep: string) =>
      `.tap-overlay-hit[data-device-instance="${id}"][data-device-control="${ep}"]`;
    await page.waitForFunction((sel: string) => {
      const stack: (Document | ShadowRoot)[] = [document];
      while (stack.length) {
        const root = stack.pop()!;
        const hit = root.querySelector(sel) as HTMLElement | null;
        if (hit && hit.getBoundingClientRect().width > 0) return true;
        for (const el of root.querySelectorAll('*')) if ((el as HTMLElement).shadowRoot) stack.push((el as HTMLElement).shadowRoot!);
      }
      return false;
    }, { timeout: 10_000 }, surfSel(dev, 'b0/e01/turn'));
    // Both library devices show; "in use" narrows to the wired one.
    expect(await deepCount(`device-surface`)).toBeGreaterThan(1);

    // Drag the Twister's knob 2 (its ring) onto the inspector's lightness.
    const knob = await deepCentre(surfSel(dev, 'b0/e01/turn'));
    const light = await deepCentre('.tap-overlay-hit[data-field-path="lightness"]');
    expect(knob).not.toBeNull();
    expect(light).not.toBeNull();
    const r = await page.evaluate((sel: string) => {
      const stack: (Document | ShadowRoot)[] = [document];
      while (stack.length) {
        const root = stack.pop()!;
        const hit = root.querySelector(sel) as HTMLElement | null;
        if (hit) { const b = hit.getBoundingClientRect(); return { w: b.width }; }
        for (const el of root.querySelectorAll('*')) if ((el as HTMLElement).shadowRoot) stack.push((el as HTMLElement).shadowRoot!);
      }
      return null;
    }, surfSel(dev, 'b0/e01/turn'));
    await drag({ x: knob!.x - r!.w * 0.4, y: knob!.y }, light!);
    const wires = () => page.evaluate((trackId: string) => JSON.parse(JSON.stringify(
      (window as any).arrangementStore.composition.tracks.find((t: any) => t.id === trackId).sketch.wires ?? [])), track);
    const w1 = await wires();
    expect(w1).toHaveLength(1);
    expect(w1[0].src).toEqual({ instanceKey: `midi:${dev}`, field: 'b0/e01/turn' });

    // "in use": only the wired device's card remains.
    await page.evaluate(() => {
      const store = (window as any).arrangementStore;
      store.setDeviceFilters({ ...store.deviceFilters, inUse: true });
    });
    await new Promise((r2) => setTimeout(r2, 200));
    expect(await deepCount(`device-surface`)).toBe(1);
    expect(await deepCount(surfSel(other, 'b0/e00/turn'))).toBe(0);

    // The card's timeline toggle adds the row (and takes it away again).
    const inc = await deepCentre(`[data-include="${dev}"]`);
    expect(inc).not.toBeNull();
    await page.mouse.click(inc!.x, inc!.y);
    expect(await page.evaluate(() => (window as any).arrangementStore.devicePlacements.length)).toBe(1);
    await page.mouse.click(inc!.x, inc!.y);
    expect(await page.evaluate(() => (window as any).arrangementStore.devicePlacements.length)).toBe(0);
    expect(await wires()).toHaveLength(1);
  });

  it('mid-wire, hovering the switch flips the main area: field → Devices → control', async () => {
    const { track } = await resetTrack([
      ['source.solid_color', { color: [0.25, 0.25, 0.25] }],
      ['color.hsl', {}],
    ]);
    const dev = await makeDevice();
    await page.evaluate((trackId: string) => {
      const store = (window as any).arrangementStore;
      if (!store.wiresMode) store.toggleWiresMode();
      store.setDeviceFilters({ ...store.deviceFilters, inUse: false });
      store.setMainView('timeline');
      store.setSelection([`track/${trackId}`]);
    }, track);
    await page.waitForFunction(() => {
      const stack: (Document | ShadowRoot)[] = [document];
      while (stack.length) {
        const root = stack.pop()!;
        if (root.querySelector('.tap-overlay-hit[data-field-path="saturation"]')) return true;
        for (const el of root.querySelectorAll('*')) if ((el as HTMLElement).shadowRoot) stack.push((el as HTMLElement).shadowRoot!);
      }
      return false;
    }, { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 300));
    // Select the field, then click again to pick it up (click-to-connect).
    const sat = await deepCentre('.tap-overlay-hit[data-field-path="saturation"]');
    await page.mouse.click(sat!.x, sat!.y);
    await page.mouse.click(sat!.x, sat!.y);
    // Hover the Devices switch: the main area flips, the gesture survives.
    const sw = await deepCentre('[data-main-view="devices"]');
    await page.mouse.move(sw!.x - 10, sw!.y);
    await page.mouse.move(sw!.x, sw!.y, { steps: 3 });
    await page.waitForFunction(() => (window as any).arrangementStore.mainView === 'devices', { timeout: 3_000 });
    await new Promise((r) => setTimeout(r, 300));
    // Land it on a control: the device is the writer.
    const sel = `.tap-overlay-hit[data-device-instance="${dev}"][data-device-control="b0/e03/turn"]`;
    const knob = await deepCentre(sel);
    expect(knob).not.toBeNull();
    const w = await page.evaluate((s2: string) => {
      const stack: (Document | ShadowRoot)[] = [document];
      while (stack.length) {
        const root = stack.pop()!;
        const hit = root.querySelector(s2) as HTMLElement | null;
        if (hit) return hit.getBoundingClientRect().width;
        for (const el of root.querySelectorAll('*')) if ((el as HTMLElement).shadowRoot) stack.push((el as HTMLElement).shadowRoot!);
      }
      return 0;
    }, sel);
    await page.mouse.move(knob!.x - w * 0.4, knob!.y, { steps: 4 });
    await page.mouse.click(knob!.x - w * 0.4, knob!.y);
    const wires = await page.evaluate((trackId: string) => JSON.parse(JSON.stringify(
      (window as any).arrangementStore.composition.tracks.find((t: any) => t.id === trackId).sketch.wires ?? [])), track);
    expect(wires).toHaveLength(1);
    expect(wires[0].src).toEqual({ instanceKey: `midi:${dev}`, field: 'b0/e03/turn' });
    expect(wires[0].dest.field).toBe('saturation');
    await page.evaluate(() => (window as any).arrangementStore.setMainView('timeline'));
  });
});
});
