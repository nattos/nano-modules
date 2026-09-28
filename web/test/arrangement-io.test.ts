/**
 * GPU e2e: clipless layers and Composition I/O routes, on both comp engines.
 *
 * A CLIPLESS layer is a timeline track with no clips whose own sketch is its
 * content (generators included), running continuously. I/O ROUTES carry a
 * track's output (or a named port) into texture fields on other tracks.
 *
 *   GPU_TEST_BASE_URL=http://localhost:5173 npx jest arrangement-io
 */

import { CENTER, sampleMonitor, waitForMonitor } from './arr-test-helpers';

import { arrangementUrl, forEachCompBackend } from './comp-backend';

const BASE = process.env.GPU_TEST_BASE_URL || process.env.ARR_BASE_URL || 'http://localhost:5173';
let URL = '';

/** Reset to N empty timeline tracks (no clips, empty sketches, no routes). */
async function resetTracks(n: number) {
  await page.evaluate((count: number) => {
    const store = (window as any).arrangementStore;
    while (store.composition.tracks.filter((t: any) => t.kind === 'track').length < count) store.addTrack();
    for (const t of store.composition.tracks) {
      if (t.kind !== 'track') continue;
      t.clips = []; t.sketch.devices = []; t.sketch.wires = [];
      t.bypassed = false; t.soloed = false; t.level = undefined; t.blendMode = undefined;
      t.ports = undefined; t.output = undefined;
    }
    store.composition.routes = [];
    store.positionBeat = 16;
  }, n);
}

const centre = async () => (await sampleMonitor(page, [CENTER]))?.[0];

/** Centre of the first element matching `sel` anywhere in the (shadow) tree. */
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

async function drag(from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / 8, from.y + ((to.y - from.y) * i) / 8);
  }
  await new Promise((r) => setTimeout(r, 60)); // the drop-target highlight runs on rAF
  await page.mouse.up();
}

forEachCompBackend(() => {
beforeAll(() => { URL = arrangementUrl(BASE); });

describe('Arrangement clipless layers + I/O routes (GPU)', () => {
  jest.setTimeout(60_000);

  beforeAll(async () => {
    // Room for the timeline AND the inspector: the gesture test drags between them.
    await page.setViewport({ width: 1600, height: 1000 });
    await page.goto(URL, { waitUntil: 'networkidle0' });
    await page.waitForFunction(
      () => !!(window as any).arrangementStore && !!customElements.get('arrangement-app'),
      { timeout: 20_000 },
    );
  });

  it('a clipless track with a generator renders continuously', async () => {
    await resetTracks(1);
    await page.evaluate(() => {
      const store = (window as any).arrangementStore;
      const t = store.composition.tracks.find((x: any) => x.kind === 'track');
      const id = store.insertTrackDeviceAt(t.id, 0, 'source.solid_color');
      store.setTrackDeviceField(t.id, id, 'color', [1, 0, 0]);
    });
    await waitForMonitor(page, [CENTER], ([s]) => s.r > 200 && s.g < 40 && s.b < 40);
    // No clip span to fall out of: far along the timeline it still plays.
    await page.evaluate(() => { (window as any).arrangementStore.positionBeat = 900; });
    await waitForMonitor(page, [CENTER], ([s]) => s.r > 200 && s.g < 40);
    const s = await centre();
    expect(s!.r).toBeGreaterThan(200);
  });

  it('an effect-only clipless track processes the stack below it', async () => {
    await resetTracks(2);
    await page.evaluate(() => {
      const store = (window as any).arrangementStore;
      const [top, adj] = store.composition.tracks.filter((x: any) => x.kind === 'track');
      // Top: a black solid clip. Adjustment track: clipless invert → white.
      const path = store.createEmptyClip(top.id, 0, 64);
      const [, t, c] = path.split('/');
      store.addClipDeviceType(t, c, 'source.solid_color');
      const clip = store.composition.tracks.find((x: any) => x.id === t).clips
        .find((x: any) => x.id === c);
      store.setClipDeviceField(t, c, clip.sketch.devices[0].id, 'color', [0, 0, 0]);
      store.insertTrackDeviceAt(adj.id, 0, 'color.invert');
    });
    await waitForMonitor(page, [CENTER], ([s]) => s.r > 220 && s.g > 220 && s.b > 220);
    const s = await centre();
    expect(s!.g).toBeGreaterThan(220);
  });

  it('a send carries a send-nowhere track into another track\'s blend field', async () => {
    await resetTracks(3);
    await page.evaluate(() => {
      const store = (window as any).arrangementStore;
      const [vis, hid, mix] = store.composition.tracks.filter((x: any) => x.kind === 'track');
      const solid = (t: any, rgb: number[]) => {
        const id = store.insertTrackDeviceAt(t.id, 0, 'source.solid_color');
        store.setTrackDeviceField(t.id, id, 'color', rgb);
      };
      solid(vis, [0, 0, 1]);
      solid(hid, [1, 0, 0]);
      store.setTrackOutputMode(hid.id, 'none');
      const bl = store.insertTrackDeviceAt(mix.id, 0, 'composite.blend');
      store.setTrackDeviceField(mix.id, bl, 'opacity', 1);
      const out = (t: any) => ({ kind: 'port', trackId: t.id, portId: '__out__' });
      const f = (field: string) => ({ kind: 'field', trackId: mix.id, deviceId: bl, field });
      if (!store.addRoute(out(vis), f('tex_a'))) throw new Error('route a refused');
      if (!store.addRoute(out(hid), f('tex_b'))) throw new Error('route b refused');
    });
    // B wins at opacity 1: red, though its track never composites.
    await waitForMonitor(page, [CENTER], ([s]) => s.r > 200 && s.b < 40);
    const hasLive = await page.evaluate(() => {
      const st = (window as any).arrangementStore.routeStatus;
      return Object.values(st).filter((v: any) => v.live).length;
    });
    expect(hasLive).toBe(2);
    // Fader to A: the other route (blue).
    await page.evaluate(() => {
      const store = (window as any).arrangementStore;
      const mix = store.composition.tracks.filter((x: any) => x.kind === 'track')[2];
      store.setTrackDeviceField(mix.id, mix.sketch.devices[0].id, 'opacity', 0);
    });
    await waitForMonitor(page, [CENTER], ([s]) => s.b > 200 && s.r < 40);
    // Drop the blend: what composites is the stack alone — blue, because the
    // red track is sent nowhere.
    await page.evaluate(() => {
      const store = (window as any).arrangementStore;
      const mix = store.composition.tracks.filter((x: any) => x.kind === 'track')[2];
      store.removeTrackDevice(mix.id, mix.sketch.devices[0].id);
    });
    await waitForMonitor(page, [CENTER], ([s]) => s.b > 200 && s.r < 40);
    // The device's routes were pruned with it.
    expect(await page.evaluate(() => ((window as any).arrangementStore.composition.routes ?? []).length))
      .toBe(0);
  });

  it('a track whose content is its routed input shows it', async () => {
    await resetTracks(2);
    await page.evaluate(() => {
      const store = (window as any).arrangementStore;
      const [hid, tap] = store.composition.tracks.filter((x: any) => x.kind === 'track');
      const id = store.insertTrackDeviceAt(hid.id, 0, 'source.solid_color');
      store.setTrackDeviceField(hid.id, id, 'color', [0, 1, 0]);
      store.setTrackOutputMode(hid.id, 'none');
      // The tap inverts what it receives: green in → magenta out.
      store.insertTrackDeviceAt(tap.id, 0, 'color.invert');
      store.addRoute({ kind: 'port', trackId: hid.id, portId: '__out__' },
                     { kind: 'port', trackId: tap.id, portId: '__in__' });
    });
    await waitForMonitor(page, [CENTER], ([s]) => s.r > 200 && s.b > 200 && s.g < 40);
    // Send the tap nowhere too: nothing composites (the green source is hidden).
    await page.evaluate(() => {
      const store = (window as any).arrangementStore;
      const tap = store.composition.tracks.filter((x: any) => x.kind === 'track')[1];
      store.setTrackOutputMode(tap.id, 'none');
    });
    await waitForMonitor(page, [CENTER], ([s]) => s.r < 40 && s.g < 40 && s.b < 40);
  });

  it('I/O mode: dragging between header ports and inspector fields makes routes', async () => {
    await resetTracks(2);
    const ids = await page.evaluate(() => {
      const store = (window as any).arrangementStore;
      const [src, mix] = store.composition.tracks.filter((x: any) => x.kind === 'track');
      store.insertTrackDeviceAt(src.id, 0, 'source.noise');
      const bl = store.insertTrackDeviceAt(mix.id, 0, 'composite.blend');
      if (!store.ioMode) store.toggleIoMode();
      if (!store.wiresMode) store.toggleWiresMode();
      store.setSelection([`track/${mix.id}`]);
      return { src: src.id, mix: mix.id, bl };
    });
    // Let the inspector mount the blend's card before reading its geometry.
    await page.waitForFunction(() => {
      const stack: (Document | ShadowRoot)[] = [document];
      while (stack.length) {
        const root = stack.pop()!;
        if (root.querySelector('.tap-overlay-hit[data-field-path="tex_b"]')) return true;
        for (const el of root.querySelectorAll('*')) if ((el as HTMLElement).shadowRoot) stack.push((el as HTMLElement).shadowRoot!);
      }
      return false;
    }, { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 300));
    // Port → field: src's out pip onto the blend's tex_b row.
    const pip = await deepCentre(`.port[data-port-track="${ids.src}"][data-port-id="__out__"]`);
    const texB = await deepCentre('.tap-overlay-hit[data-field-path="tex_b"]');
    expect(pip).not.toBeNull();
    expect(texB).not.toBeNull();
    await drag(pip!, texB!);
    const r1 = await page.evaluate(() => JSON.parse(JSON.stringify(
      (window as any).arrangementStore.composition.routes ?? [])));
    expect(r1).toHaveLength(1);
    expect(r1[0].src).toEqual({ kind: 'port', trackId: ids.src, portId: '__out__' });
    expect(r1[0].dest).toMatchObject({ kind: 'field', trackId: ids.mix, deviceId: ids.bl, field: 'tex_b' });

    // Field → port: the same field dropped on mix's own __in__ is illegal (an
    // input can't feed an input) — nothing changes.
    const mixIn = await deepCentre(`.port[data-port-track="${ids.mix}"][data-port-id="__in__"]`);
    const texA = await deepCentre('.tap-overlay-hit[data-field-path="tex_a"]');
    await drag(texA!, mixIn!);
    expect(await page.evaluate(() => ((window as any).arrangementStore.composition.routes ?? []).length)).toBe(1);

    // Port → port: src's out onto mix's in.
    const srcOut = await deepCentre(`.port[data-port-track="${ids.src}"][data-port-id="__out__"]`);
    await drag(srcOut!, mixIn!);
    const r2 = await page.evaluate(() => JSON.parse(JSON.stringify(
      (window as any).arrangementStore.composition.routes ?? [])));
    expect(r2).toHaveLength(2);
    expect(r2[1].dest).toEqual({ kind: 'port', trackId: ids.mix, portId: '__in__' });

    // Field → named port (a FEED): the blend's tex_out onto a new out port.
    const port = await page.evaluate((mixId: string) => {
      const store = (window as any).arrangementStore;
      const id = store.addTrackPort(mixId, 'out', 'Side');
      store.closePortPopup();
      return id;
    }, ids.mix);
    await new Promise((r) => setTimeout(r, 200));
    const side = await deepCentre(`.port[data-port-track="${ids.mix}"][data-port-id="${port}"]`);
    const texOut = await deepCentre('.tap-overlay-hit[data-field-path="tex_out"]');
    expect(side).not.toBeNull();
    expect(texOut).not.toBeNull();
    await drag(texOut!, side!);
    const r3 = await page.evaluate(() => JSON.parse(JSON.stringify(
      (window as any).arrangementStore.composition.routes ?? [])));
    expect(r3).toHaveLength(3);
    expect(r3[2].src).toMatchObject({ kind: 'field', deviceId: ids.bl, field: 'tex_out' });
    expect(r3[2].dest).toEqual({ kind: 'port', trackId: ids.mix, portId: port });
  });

  it('a named out port follows whichever clip plays', async () => {
    await resetTracks(2);
    await page.evaluate(() => {
      const store = (window as any).arrangementStore;
      const [src, tap] = store.composition.tracks.filter((x: any) => x.kind === 'track');
      const port = store.addTrackPort(src.id, 'out', 'Look');
      const clipWith = (start: number, rgb: number[]) => {
        const [, t, c] = store.createEmptyClip(src.id, start, 8).split('/');
        store.addClipDeviceType(t, c, 'source.solid_color');
        const dev = store.composition.tracks.find((x: any) => x.id === t).clips
          .find((x: any) => x.id === c).sketch.devices[0];
        store.setClipDeviceField(t, c, dev.id, 'color', rgb);
        store.addRoute({ kind: 'field', trackId: t, clipId: c, deviceId: dev.id, field: 'tex_out' },
                       { kind: 'port', trackId: src.id, portId: port });
      };
      clipWith(0, [0, 1, 0]);
      clipWith(8, [0, 0, 1]);
      store.setTrackOutputMode(src.id, 'none');
      store.insertTrackDeviceAt(tap.id, 0, 'color.invert');
      store.addRoute({ kind: 'port', trackId: src.id, portId: port },
                     { kind: 'port', trackId: tap.id, portId: '__in__' });
      store.positionBeat = 4;
    });
    // Inverted through the tap: green → magenta, then blue → yellow.
    await waitForMonitor(page, [CENTER], ([s]) => s.r > 200 && s.b > 200 && s.g < 40);
    await page.evaluate(() => { (window as any).arrangementStore.positionBeat = 12; });
    await waitForMonitor(page, [CENTER], ([s]) => s.r > 200 && s.g > 200 && s.b < 40);
  });
});
});
