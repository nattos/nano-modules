/**
 * GPU e2e: MIDI devices in the arrangement, on both comp engines.
 *
 * A show INCLUDES library devices (a device row under the tracks); a MIDI
 * control wired to a field drives it through the composition — the worker
 * engine gets the lowered value table, the native compositor gets the
 * on-screen simulation over the bridge and merges it in its own MIDI host.
 * A PARKED device's wires stay but go inert.
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

  it('a knob on a track’s opacity drives the picture; parking the device releases it', async () => {
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
    expect(await page.evaluate(() => (window as any).arrangementStore.devicePlacements.length)).toBe(1);

    await setKnob(dev, 'b0/e00/turn', 0);
    await waitForMonitor(page, [CENTER], ([s]) => s.r < 30 && s.g < 30 && s.b < 30);
    await setKnob(dev, 'b0/e00/turn', 1);
    await waitForMonitor(page, [CENTER], ([s]) => s.r > 200 && s.g > 200);
    await setKnob(dev, 'b0/e00/turn', 0);
    await waitForMonitor(page, [CENTER], ([s]) => s.r < 30);

    // Parked: the wire stays in the document but the layer is back to its
    // authored opacity.
    await page.evaluate(() => {
      const store = (window as any).arrangementStore;
      store.setDeviceEnabled(store.devicePlacements[0].id, false);
    });
    await waitForMonitor(page, [CENTER], ([s]) => s.r > 150);
    expect(await page.evaluate((id: string) =>
      (window as any).arrangementStore.deviceWireCount(id), dev)).toBe(1);
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

    // Removing the device takes its wire with it.
    await page.evaluate(() => {
      const store = (window as any).arrangementStore;
      store.removeDevicePlacement(store.devicePlacements[0].id);
    });
    expect(await page.evaluate((trackId: string) =>
      ((window as any).arrangementStore.composition.tracks.find((t: any) => t.id === trackId).sketch.wires ?? []).length,
    track)).toBe(0);
    expect(await deepCount(knobSel)).toBe(0);
  });
});
});
