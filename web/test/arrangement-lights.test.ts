/**
 * GPU e2e: light devices in the arrangement (the devices push, D2).
 *
 * On both engines: a rig made in the Devices view (template → type → rig),
 * added to the show (a timeline row), laid out per show (one undo point per
 * drag), swapped (addresses move, positions stay), and routed — a track's out
 * port dragged across the Timeline | Devices switch onto the light's input.
 *
 * Native only: the compositor TRANSMITS. Its DMX goes to the loopback port
 * the harness redirects every destination to (comp-backend.ts
 * artnetRedirectPort — never the LAN), where this suite listens and checks the
 * bytes: the picture, then a routed track, then a test pattern.
 *
 *   GPU_TEST_BASE_URL=http://localhost:5173 npx jest -i arrangement-lights
 */

import * as dgram from 'dgram';
import { arrangementUrl, artnetRedirectPort, forEachCompBackend, nativeOnly } from './comp-backend';

const BASE = process.env.GPU_TEST_BASE_URL || process.env.ARR_BASE_URL || 'http://localhost:5173';
let URL = '';

type Pt = { x: number; y: number };

/** Every shadow root's first visible match's centre — scrolled into view
 *  first (a long Devices view, e.g. after another suite's MIDI devices, puts
 *  later sections below the fold, where a click lands on nothing). */
async function deepCentre(sel: string): Promise<Pt | null> {
  return page.evaluate((selector: string) => {
    const stack: (Document | ShadowRoot)[] = [document];
    while (stack.length) {
      const root = stack.pop()!;
      for (const hit of root.querySelectorAll(selector) as NodeListOf<HTMLElement>) {
        let r = hit.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && getComputedStyle(hit).visibility !== 'hidden') {
          if (r.bottom > innerHeight || r.top < 0) {
            hit.scrollIntoView({ block: 'center' });
            r = hit.getBoundingClientRect();
          }
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
      }
      for (const el of root.querySelectorAll('*')) {
        if ((el as HTMLElement).shadowRoot) stack.push((el as HTMLElement).shadowRoot!);
      }
    }
    return null;
  }, sel);
}

async function waitDeep(sel: string, timeout = 10_000): Promise<Pt> {
  const until = Date.now() + timeout;
  for (;;) {
    const c = await deepCentre(sel);
    if (c) return c;
    if (Date.now() > until) throw new Error(`not found: ${sel}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function clickDeep(sel: string) {
  const c = await waitDeep(sel);
  await page.mouse.click(c.x, c.y);
}

/** Set a <select> anywhere in the shadow tree and fire its change. */
async function selectDeep(sel: string, value: string) {
  await waitDeep(sel);
  await page.evaluate((selector: string, v: string) => {
    const stack: (Document | ShadowRoot)[] = [document];
    while (stack.length) {
      const root = stack.pop()!;
      const hit = root.querySelector(selector) as HTMLSelectElement | null;
      if (hit) { hit.value = v; hit.dispatchEvent(new Event('change', { bubbles: true })); return; }
      for (const el of root.querySelectorAll('*')) if (el.shadowRoot) stack.push(el.shadowRoot);
    }
  }, sel, value);
}

/** Fresh show: one clipless track holding a solid colour, a second one (sent
 *  nowhere) holding another; no devices, no routes. The light library starts
 *  empty in memory (earlier runs' rows stay in this profile's storage). */
async function resetShow(a: number[], b: number[]) {
  return page.evaluate((ca: number[], cb: number[]) => {
    const store = (window as any).arrangementStore;
    const lc = (window as any).lightController;
    lc.library = [];
    // The master output switch starts off at launch; these tests transmit.
    (window as any).outputMaster.set(true);
    while (store.composition.tracks.filter((t: any) => t.kind === 'track').length < 2) store.addTrack();
    const tracks = store.composition.tracks.filter((t: any) => t.kind === 'track');
    for (const t of tracks) {
      t.clips = []; t.sketch.devices = []; t.sketch.wires = [];
      t.bypassed = false; t.soloed = false; t.level = undefined; t.blendMode = undefined;
      t.ports = undefined; t.output = undefined;
    }
    store.composition.routes = undefined;
    store.composition.devices = undefined;
    store.setDeviceFilters({ ...store.deviceFilters, inUse: false, templates: true });
    const [t1, t2] = tracks;
    const d1 = store.insertTrackDeviceAt(t1.id, 0, 'source.solid_color');
    store.setTrackDeviceField(t1.id, d1, 'color', ca);
    const d2 = store.insertTrackDeviceAt(t2.id, 0, 'source.solid_color');
    store.setTrackDeviceField(t2.id, d2, 'color', cb);
    store.setTrackOutputMode(t2.id, 'none');
    store.setMainView('devices');
    return { t1: t1.id as string, t2: t2.id as string };
  }, a, b);
}

/** A rig of `count` 10-px RGBW bars from the template, via the controller. */
async function makeRig(count: number): Promise<{ rig: string; pid: string }> {
  return page.evaluate((n: number) => {
    const lc = (window as any).lightController;
    const store = (window as any).arrangementStore;
    const t = lc.newType('light.strip');
    const rig = lc.newRig({ typeId: t.id, count: n, start: { universe: 0, channel: 1, dest: 'broadcast' } });
    const pid = store.includeDevice(rig.id, { kind: 'light', label: rig.name });
    return { rig: rig.id as string, pid: pid as string };
  }, count);
}

forEachCompBackend((backend) => {
beforeAll(() => { URL = arrangementUrl(BASE); });

describe('Arrangement lights (GPU)', () => {
  jest.setTimeout(60_000);

  beforeAll(async () => {
    await page.setViewport({ width: 1600, height: 1000 });
    await page.goto(URL, { waitUntil: 'networkidle0' });
    await page.waitForFunction(
      () => !!(window as any).arrangementStore && !!(window as any).lightController
        && !!customElements.get('arrangement-app'),
      { timeout: 20_000 },
    );
  });

  // The main view and I/O mode persist: leave the timeline up for the next suite.
  afterAll(async () => {
    await page.evaluate(() => {
      const store = (window as any).arrangementStore;
      store.setMainView('timeline');
      if (store.ioMode) store.toggleIoMode();
    });
  });

  it('template → type → rig from the Devices view; "add to show" gives it a row', async () => {
    await resetShow([1, 0, 0], [0, 1, 0]);
    // "+ rig" makes a type from the template and selects it; its details
    // offer the new-rig form (4 bars by default).
    await clickDeep('[data-light-action="add-rig"]');
    await clickDeep('[data-light-action="new-rig"]');
    const rig = await page.evaluate(() => {
      const r = (window as any).lightController.rigs[0];
      return { id: r.id, channels: r.slots.map((s: any) => s.address.channel) };
    });
    expect(rig.channels).toEqual([1, 41, 81, 121]);
    // The card's toggle includes it: a light placement (on), and a row.
    await clickDeep(`[data-light-include="${rig.id}"]`);
    const p = await page.evaluate(() => JSON.parse(JSON.stringify(
      (window as any).arrangementStore.lightPlacements)));
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ kind: 'light', deviceId: rig.id });
    await page.evaluate(() => (window as any).arrangementStore.setMainView('timeline'));
    await waitDeep(`[data-light-row="${p[0].id}"]`);
  });

  it('selecting a light row shows it in the inspector — the timeline stays', async () => {
    await resetShow([1, 0, 0], [0, 1, 0]);
    const { rig, pid } = await makeRig(4);
    await page.evaluate(() => {
      const store = (window as any).arrangementStore;
      store.clearSelection();
      store.setMainView('timeline');
      store.showRightTab('inspector');
    });
    // The lane draws the rig (its bars where they sample), scaled to the row.
    await waitDeep(`[data-light-row="${pid}"] arr-light-lane`);
    const bars = await page.evaluate((p: string) => {
      const stack: (Document | ShadowRoot)[] = [document];
      while (stack.length) {
        const root = stack.pop()!;
        const lane = root.querySelector(`[data-light-row="${p}"] arr-light-lane`);
        if (lane) {
          const surf = lane.shadowRoot!.querySelector('light-rig-surface[compact]');
          return surf?.shadowRoot?.querySelectorAll('g[data-slot]').length ?? -1;
        }
        for (const el of root.querySelectorAll('*')) if (el.shadowRoot) stack.push(el.shadowRoot);
      }
      return -2;
    }, pid);
    expect(bars).toBe(4);
    await clickDeep(`[data-light-row="${pid}"] .header .tname`);
    const after = await page.evaluate(() => {
      const store = (window as any).arrangementStore;
      return { view: store.mainView, path: store.primaryPath };
    });
    expect(after).toEqual({ view: 'timeline', path: `device/${pid}` });
    // The inspector says what it is; its button is the way to Devices.
    await waitDeep('[data-inspector-light-enable]');
    await clickDeep('[data-inspector-action="edit-in-devices"]');
    expect(await page.evaluate(() => (window as any).arrangementStore.mainView)).toBe('devices');
    await waitDeep(`[data-light-card="${rig}"][selected]`);
  });

  it('a type hung horizontally: its pixels run across, a new rig stacks down the frame', async () => {
    await resetShow([1, 0, 0], [0, 1, 0]);
    const typeId = await page.evaluate(() => (window as any).lightController.newType('light.strip').id);
    await clickDeep(`[data-light-card="${typeId}"]`);
    await clickDeep('[data-light-orient="horizontal"]');
    expect(await page.evaluate((id: string) => (window as any).lightController.type(id).vertical, typeId)).toBe(false);
    const layout = await page.evaluate((id: string) => {
      const lc = (window as any).lightController;
      const rig = lc.newRig({ typeId: id, count: 2, start: { universe: 0, channel: 1, dest: 'broadcast' } });
      return rig.slots.map((s: any) => s.layout);
    }, typeId);
    expect(layout.map((r: any) => r.w)).toEqual([1, 1]);
    expect(layout[0].y).toBeLessThan(layout[1].y);
  });

  it('networks: "+ network", a bar put on it, then "switch all" for the rest of the rig', async () => {
    await resetShow([1, 0, 0], [0, 1, 0]);
    const { rig } = await makeRig(4);
    await clickDeep('[data-light-action="add-network"]');
    const netId = await page.evaluate(() => (window as any).lightController.networks[0]?.id);
    expect(netId).toBeTruthy();
    await waitDeep(`[data-light-card="${netId}"][selected]`);
    await waitDeep('[data-light-action="add-override"]');
    // Its bar picker on the rig: bar 1 → the network, and the offer appears.
    await clickDeep(`[data-light-card="${rig}"]`);
    await selectDeep('[data-light-net="0"]', netId);
    expect(await page.evaluate((id: string) =>
      (window as any).lightController.rig(id).slots[0].address.network, rig)).toBe(netId);
    await clickDeep('[data-light-action="net-all"]');
    expect(await page.evaluate((id: string) => (window as any).lightController.rig(id).slots
      .map((s: any) => s.address.network), rig)).toEqual([netId, netId, netId, netId]);
    // …and the offer is gone.
    expect(await deepCentre('[data-light-action="net-all"]')).toBeNull();
  });

  it('networks: Loopback is built in — a bar on it is planned to 127.0.0.1', async () => {
    await resetShow([1, 0, 0], [0, 1, 0]);
    const { rig } = await makeRig(2);
    await waitDeep('[data-light-card="net.loopback"]');
    await clickDeep('[data-light-card="net.loopback"]');
    await waitDeep('[data-light-action="duplicate-network"]');
    await clickDeep(`[data-light-card="${rig}"]`);
    await selectDeep('[data-light-net="1"]', 'net.loopback');
    expect(await page.evaluate((id: string) => (window as any).lightController.rig(id).slots
      .map((s: any) => s.address.network ?? null), rig)).toEqual([null, 'net.loopback']);
    // What the engine is handed: bar 2 unicast to this machine, on the default socket.
    const fixtures = await page.evaluate(() =>
      JSON.parse((window as any).lightController.lastPlanJson).outputs[0].fixtures
        .map((f: any) => [f.iface, f.dest]));
    expect(fixtures).toEqual([['', 'broadcast'], ['', '127.0.0.1']]);
  });

  it('layout: dragging a strip moves it in THIS show, as one undo point', async () => {
    await resetShow([1, 0, 0], [0, 1, 0]);
    const { rig, pid } = await makeRig(4);
    await page.evaluate((id: string) => {
      (window as any).arrangementStore.setMainView('devices');
    }, rig);
    await clickDeep(`[data-light-card="${rig}"]`);
    const slot1 = await page.evaluate((id: string) => (window as any).lightController.rig(id).slots[1].id, rig);
    const grab = await waitDeep(`[data-layout-slot="${slot1}"] .grab`);
    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) await page.mouse.move(grab.x + i * 10, grab.y);
    await page.mouse.up();
    const x = await page.evaluate((p: string, s: string) =>
      (window as any).arrangementStore.placementById(p).layout?.[s]?.x, pid, slot1);
    expect(x).toBeGreaterThan(0.375);
    // The rig's own default is untouched.
    expect(await page.evaluate((id: string) =>
      (window as any).lightController.rig(id).slots[1].layout.x, rig)).toBeCloseTo(0.375 - 1 / 120);
    await page.evaluate(() => (window as any).arrangementStore.undo());
    expect(await page.evaluate((p: string) =>
      (window as any).arrangementStore.placementById(p).layout, pid)).toBeUndefined();
  });

  it('swap: two bars exchange addresses; where they sample stays', async () => {
    await resetShow([1, 0, 0], [0, 1, 0]);
    const { rig } = await makeRig(4);
    await page.evaluate(() => (window as any).arrangementStore.setMainView('devices'));
    await clickDeep(`[data-light-card="${rig}"]`);
    await clickDeep('[data-light-swap="1"]');  // bars 2 ↔ 3
    const slots = await page.evaluate((id: string) => (window as any).lightController.rig(id).slots
      .map((s: any) => [s.address.channel, Math.round((s.layout.x + s.layout.w / 2) * 1000)]), rig);
    expect(slots).toEqual([[1, 125], [81, 375], [41, 625], [121, 875]]);
  });

  it('route: a track’s out port, dragged across the switch, onto the light’s input', async () => {
    const { t2 } = await resetShow([1, 0, 0], [0, 1, 0]);
    const { pid } = await makeRig(1);
    await page.evaluate(() => {
      const store = (window as any).arrangementStore;
      store.setMainView('timeline');
      if (!store.ioMode) store.toggleIoMode();
    });
    const out = await waitDeep(`.port[data-port-track="${t2}"][data-port-id="__out__"]`);
    await page.mouse.move(out.x, out.y);
    await page.mouse.down();
    await page.mouse.move(out.x + 30, out.y + 10, { steps: 4 });
    // Hover the Devices switch: the main area flips mid-drag.
    const sw = await waitDeep('[data-main-view="devices"]');
    await page.mouse.move(sw.x, sw.y, { steps: 6 });
    await page.waitForFunction(() => (window as any).arrangementStore.mainView === 'devices', { timeout: 3_000 });
    await new Promise((r) => setTimeout(r, 300));
    const pip = await waitDeep(`[data-device-input="${pid}"]`);
    await page.mouse.move(pip.x, pip.y, { steps: 6 });
    await new Promise((r) => setTimeout(r, 60));
    await page.mouse.up();
    const route = await page.evaluate((p: string) => JSON.parse(JSON.stringify(
      (window as any).arrangementStore.deviceInputRoute(p) ?? null)), pid);
    expect(route).toMatchObject({
      src: { kind: 'port', trackId: t2, portId: '__out__' },
      dest: { kind: 'device', placementId: pid },
    });
    await page.evaluate(() => {
      const store = (window as any).arrangementStore;
      if (store.ioMode) store.toggleIoMode();
    });
  });

  nativeOnly(backend, 'no UDP in a browser')(
    'transmits: the picture, a routed track, a test pattern — to the redirect port', async () => {
      // Listen where the harness redirects every light's DMX.
      const sock = dgram.createSocket('udp4');
      let last: Buffer | null = null;
      sock.on('message', (m) => {
        // ArtDmx (opcode 0x5000, little endian) for universe 0.
        if (m.length >= 22 && m[8] === 0x00 && m[9] === 0x50 && m[14] === 0 && m[15] === 0) last = m;
      });
      await new Promise<void>((r) => sock.bind(artnetRedirectPort(), '127.0.0.1', () => r()));
      const rgbw = () => (last ? [last[18], last[19], last[20], last[21]] : null);
      const waitFor = async (want: number[], what: string) => {
        const until = Date.now() + 10_000;
        while (Date.now() < until) {
          const v = rgbw();
          if (v && v.every((b, i) => Math.abs(b - want[i]) <= 3)) return;
          await new Promise((r) => setTimeout(r, 50));
        }
        throw new Error(`${what}: got ${JSON.stringify(rgbw())}, want ${JSON.stringify(want)}`);
      };
      try {
        const { t2 } = await resetShow([1, 0, 0], [0, 1, 0]);
        const { pid } = await makeRig(2);
        // The main output is red: RGBW (255, 0, 0, 0).
        await waitFor([255, 0, 0, 0], 'the composite');
        // The compositor lists this machine's interfaces (for a network's picker).
        await page.waitForFunction(() => ((window as any).lightController.netIfaces ?? [])
          .some((i: any) => i.loopback && i.address === '127.0.0.1'), { timeout: 5_000 });
        // The UI draws what it sends.
        await page.waitForFunction((p: string) => {
          const v = (window as any).lightController.values[p];
          return v && v[0] > 240 && v[1] < 20;
        }, { timeout: 5_000 }, pid);

        // Routed from the green track (sent nowhere, so the picture stays red).
        await page.evaluate((p: string, t: string) => {
          (window as any).arrangementStore.addRoute(
            { kind: 'port', trackId: t, portId: '__out__' }, { kind: 'device', placementId: p });
        }, pid, t2);
        await waitFor([0, 255, 0, 0], 'the routed track');

        // A test pattern overrides: white is all W on an RGBW bar.
        await page.evaluate((p: string) => (window as any).lightController.test(p, null, 'white'), pid);
        await waitFor([0, 0, 0, 255], 'the white test');
        await page.evaluate((p: string) => (window as any).lightController.test(p, null, null), pid);
        await waitFor([0, 255, 0, 0], 'after the test');

        // "bars": one bar at a time, in rig order (bar 2's W is channel 41+3).
        await page.evaluate((p: string) => (window as any).lightController.test(p, null, 'bars'), pid);
        const whites = () => (last ? [last[21], last[18 + 43]] : null);
        const waitWhites = async (want: number[], what: string) => {
          const until = Date.now() + 10_000;
          while (Date.now() < until) {
            const v = whites();
            if (v && v[0] === want[0] && v[1] === want[1]) return;
            await new Promise((r) => setTimeout(r, 20));
          }
          throw new Error(`${what}: got ${JSON.stringify(whites())}, want ${JSON.stringify(want)}`);
        };
        await waitWhites([255, 0], 'bars: the first bar');
        await waitWhites([0, 255], 'bars: then the second');
        await page.evaluate((p: string) => (window as any).lightController.test(p, null, null), pid);
        await waitFor([0, 255, 0, 0], 'after the bars test');

        // Output off: it stops sending.
        await page.evaluate((p: string) => (window as any).arrangementStore.setLightEnabled(p, false), pid);
        await new Promise((r) => setTimeout(r, 300));
        last = null;
        await new Promise((r) => setTimeout(r, 400));
        expect(last).toBeNull();
      } finally {
        sock.close();
      }
    });
});
});
