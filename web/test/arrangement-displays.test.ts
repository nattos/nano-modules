/**
 * GPU e2e: display devices in the arrangement (the devices push, D3).
 *
 * On both engines: Display 1 and 2 in the Devices view, "add to show" gives a
 * row; selecting the row inspects it (the timeline stays); the fit is a show
 * edit (one undo); a track's out port routes onto a display's input pip.
 *
 * Native only: the compositor PRESENTS. The harness never lets it open a
 * window: NANO_DISPLAY_REDIRECT=offscreen + fake screens (comp-backend.ts
 * FAKE_SCREENS — the "machine" has its main screen and a 4:3 projector), and
 * the report's probe of each offscreen target says what a screen would show:
 * the picture letterboxed under Fit, filled under Stretch, the routed track,
 * nothing when off. Display 1 lands on the projector by itself — never the
 * main screen.
 *
 *   GPU_TEST_BASE_URL=http://localhost:5173 npx jest -i arrangement-displays
 */

import { arrangementUrl, FAKE_SCREENS, forEachCompBackend, nativeOnly } from './comp-backend';

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

/** Fresh show: two clipless tracks of solid colour, the second sent nowhere;
 *  no devices, no routes; the display library empty (in memory). */
async function resetShow(a: number[], b: number[]) {
  return page.evaluate((ca: number[], cb: number[]) => {
    const store = (window as any).arrangementStore;
    const dc = (window as any).displayController;
    dc.library = [];
    dc.pushPlan();
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
    store.setTransportMode('live');
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

/** Select a display card (a click on a selected one deselects it). */
async function selectCard(slot: string) {
  await page.evaluate(() => (window as any).arrangementStore.setMainView('devices'));
  for (let i = 0; i < 3; i++) {
    if (await deepCentre(`[data-display-card="${slot}"][selected]`)) return;
    await clickDeep(`[data-display-card="${slot}"]`);
  }
  await waitDeep(`[data-display-card="${slot}"][selected]`);
}

/** Display `slot` in the show, via the store. */
async function place(slot = 'display.1'): Promise<string> {
  return page.evaluate((s: string) =>
    (window as any).arrangementStore.includeDevice(s, { kind: 'display', label: 'Display 1' }), slot);
}

/** The display's offscreen probe (16×16 RGB) → [centre, top-centre] pixels,
 *  or null before the first. */
async function probe(pid: string): Promise<{ mid: number[]; top: number[]; state: string } | null> {
  return page.evaluate((p: string) => {
    const st = (window as any).displayController.status[p];
    if (!st?.probe) return null;
    const bin = atob(st.probe);
    const px = (x: number, y: number) => [0, 1, 2].map((c) => bin.charCodeAt((y * 16 + x) * 3 + c));
    return { mid: px(8, 8), top: px(8, 0), state: st.state };
  }, pid);
}

async function waitProbe(pid: string, ok: (p: { mid: number[]; top: number[] }) => boolean, what: string) {
  const until = Date.now() + 10_000;
  let last: unknown = null;
  while (Date.now() < until) {
    const p = await probe(pid);
    last = p;
    if (p && ok(p)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${what}: last probe ${JSON.stringify(last)}`);
}

const red = (c: number[]) => c[0] > 230 && c[1] < 30 && c[2] < 30;
const green = (c: number[]) => c[1] > 230 && c[0] < 30 && c[2] < 30;
const black = (c: number[]) => c.every((v) => v < 20);

forEachCompBackend((backend) => {
beforeAll(() => { URL = arrangementUrl(BASE); });

describe('Arrangement displays (GPU)', () => {
  jest.setTimeout(60_000);

  beforeAll(async () => {
    await page.setViewport({ width: 1600, height: 1000 });
    await page.goto(URL, { waitUntil: 'networkidle0' });
    await page.waitForFunction(
      () => !!(window as any).arrangementStore && !!(window as any).displayController
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

  it('Display 1 and 2 are in the Devices view; "add to show" gives a row', async () => {
    await resetShow([1, 0, 0], [0, 1, 0]);
    await waitDeep('[data-display-card="display.1"]');
    await waitDeep('[data-display-card="display.2"]');
    await clickDeep('[data-display-include="display.1"]');
    const p = await page.evaluate(() => JSON.parse(JSON.stringify(
      (window as any).arrangementStore.displayPlacements)));
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ kind: 'display', deviceId: 'display.1' });
    // "+ display" adds Display 3.
    await clickDeep('[data-display-action="add"]');
    await waitDeep('[data-display-card="display.3"][selected]');
    await page.evaluate(() => (window as any).arrangementStore.setMainView('timeline'));
    await waitDeep(`[data-display-row="${p[0].id}"]`);
  });

  it('selecting a display row inspects it — the timeline stays; fit is one undo', async () => {
    await resetShow([1, 0, 0], [0, 1, 0]);
    const pid = await place();
    await page.evaluate(() => {
      const store = (window as any).arrangementStore;
      store.clearSelection();
      store.setMainView('timeline');
      store.showRightTab('inspector');
    });
    await waitDeep(`[data-display-row="${pid}"] arr-display-lane`);
    await clickDeep(`[data-display-row="${pid}"] .header .tname`);
    expect(await page.evaluate(() => {
      const store = (window as any).arrangementStore;
      return { view: store.mainView, path: store.primaryPath };
    })).toEqual({ view: 'timeline', path: `device/${pid}` });
    await clickDeep('[data-inspector-display-fit="stretch"]');
    expect(await page.evaluate((p: string) =>
      (window as any).arrangementStore.placementById(p).fit, pid)).toBe('stretch');
    await page.evaluate(() => (window as any).arrangementStore.undo());
    expect(await page.evaluate((p: string) =>
      (window as any).arrangementStore.placementById(p).fit, pid)).toBeUndefined();
    // Its on/off is in the inspector too; the row's switch agrees.
    await clickDeep('[data-inspector-display-enable]');
    expect(await page.evaluate((p: string) =>
      (window as any).arrangementStore.placementById(p).enabled, pid)).toBe(false);
    await clickDeep(`[data-display-enable="${pid}"]`);
    expect(await page.evaluate((p: string) =>
      (window as any).arrangementStore.placementById(p).enabled, pid)).toBeUndefined();
  });

  it('route: a track’s out port onto the display row’s input', async () => {
    const { t2 } = await resetShow([1, 0, 0], [0, 1, 0]);
    const pid = await place();
    await page.evaluate(() => {
      const store = (window as any).arrangementStore;
      store.setMainView('timeline');
      if (!store.ioMode) store.toggleIoMode();
    });
    const out = await waitDeep(`.port[data-port-track="${t2}"][data-port-id="__out__"]`);
    await page.mouse.move(out.x, out.y);
    await page.mouse.down();
    await page.mouse.move(out.x + 20, out.y + 10, { steps: 4 });
    // Mid-gesture the row's pip wears its hit mask.
    const pip = await waitDeep(`[data-device-input="${pid}"]`);
    await page.mouse.move(pip.x, pip.y, { steps: 8 });
    await new Promise((r) => setTimeout(r, 60));
    await page.mouse.up();
    expect(await page.evaluate((p: string) => JSON.parse(JSON.stringify(
      (window as any).arrangementStore.deviceInputRoute(p) ?? null)), pid)).toMatchObject({
      src: { kind: 'port', trackId: t2, portId: '__out__' },
      dest: { kind: 'device', placementId: pid },
    });
    await page.evaluate(() => {
      const store = (window as any).arrangementStore;
      if (store.ioMode) store.toggleIoMode();
    });
  });

  it('the details: fullscreen or a window is this machine’s; the plan carries it', async () => {
    await resetShow([1, 0, 0], [0, 1, 0]);
    const pid = await place();
    await selectCard('display.1');
    await clickDeep('[data-display-mode="window"]');
    expect(await page.evaluate(() => (window as any).displayController.slot('display.1').window)).toBe(true);
    expect(await page.evaluate(() => (window as any).displayController.lastPlan.outputs))
      .toMatchObject([{ placementId: pid, slotId: 'display.1', window: true, fit: 'fit', enabled: true }]);
    await clickDeep('[data-display-mode="fullscreen"]');
    expect(await page.evaluate(() => (window as any).displayController.slot('display.1').window)).toBeUndefined();
  });

  it('the worker engine says it opens no screens; the Live button stays calm', async () => {
    await resetShow([1, 0, 0], [0, 1, 0]);
    const pid = await place();
    await page.evaluate(() => (window as any).arrangementStore.setTransportMode('precise'));
    const nudge = await page.evaluate(() => {
      const stack: (Document | ShadowRoot)[] = [document];
      while (stack.length) {
        const root = stack.pop()!;
        const b = root.querySelector('[data-transport-live]');
        if (b) return b.classList.contains('nudge');
        for (const el of root.querySelectorAll('*')) if (el.shadowRoot) stack.push(el.shadowRoot);
      }
      return null;
    });
    const outputs = await page.evaluate(() => (window as any).__engineBridge.outputsDisplays);
    // Native: a display is on while Precise could hold a frame → the nudge.
    expect(nudge).toBe(outputs);
    if (!outputs) {
      // No screens to list, and the card says why.
      expect(await page.evaluate(() => (window as any).displayController.screens)).toBeNull();
      await page.evaluate(() => (window as any).arrangementStore.setMainView('devices'));
      const subtitle = await page.evaluate(() => {
        const stack: (Document | ShadowRoot)[] = [document];
        while (stack.length) {
          const root = stack.pop()!;
          const card = root.querySelector('[data-display-card="display.1"]') as any;
          if (card) return card.subtitle as string;
          for (const el of root.querySelectorAll('*')) if (el.shadowRoot) stack.push(el.shadowRoot);
        }
        return null;
      });
      expect(subtitle).toContain('doesn’t output displays');
    }
    void pid;
    await page.evaluate(() => (window as any).arrangementStore.setTransportMode('live'));
  });

  nativeOnly(backend, 'a page can’t open screens')(
    'presents: Display 1 on the projector — Fit letterboxes, Stretch fills, routed, off', async () => {
      const { t2 } = await resetShow([1, 0, 0], [0, 1, 0]);
      // The compositor reports the (fake) screens: the main one and a projector.
      await page.waitForFunction((n: number) => ((window as any).displayController.screens ?? []).length === n,
        { timeout: 10_000 }, FAKE_SCREENS.length);
      const pid = await place();
      // Automatic: the first screen that isn't the main one.
      await page.waitForFunction((p: string) => {
        const st = (window as any).displayController.status[p];
        return st?.state === 'showing' && st.screen?.uuid === 'FAKE-PROJ';
      }, { timeout: 10_000 }, pid);
      // A 16:9 show on a 4:3 screen: black bars top and bottom under Fit.
      await waitProbe(pid, (p) => red(p.mid) && black(p.top), 'fit');
      // While it shows, the engine renders at the show's full resolution.
      expect(await page.evaluate(() => {
        const eb = (window as any).__engineBridge;
        return [eb.renderW, eb.renderH];
      })).toEqual([1920, 1080]);

      await page.evaluate((p: string) => (window as any).arrangementStore.setDisplayFit(p, 'stretch'), pid);
      await waitProbe(pid, (p) => red(p.mid) && red(p.top), 'stretch');

      // Routed from the green track (sent nowhere: the main output stays red).
      await page.evaluate((p: string, t: string) => {
        (window as any).arrangementStore.addRoute(
          { kind: 'port', trackId: t, portId: '__out__' }, { kind: 'device', placementId: p });
      }, pid, t2);
      await waitProbe(pid, (p) => green(p.mid), 'routed');

      // Pinned to the main screen by choice: it goes there.
      await selectCard('display.1');
      await selectDeep('[data-display-field="screen"]', 'FAKE-MAIN');
      await page.waitForFunction((p: string) =>
        (window as any).displayController.status[p]?.screen?.uuid === 'FAKE-MAIN', { timeout: 10_000 }, pid);

      // Identify reaches the compositor.
      await clickDeep('[data-display-action="identify"]');
      await page.waitForFunction(() => (window as any).displayController.lastIdentified?.label === 'Display 1',
        { timeout: 10_000 });

      // Off: it closes (the full-resolution render goes with it).
      await page.evaluate((p: string) => (window as any).arrangementStore.setDisplayEnabled(p, false), pid);
      await page.waitForFunction((p: string) =>
        (window as any).displayController.status[p]?.state === 'off', { timeout: 10_000 }, pid);
      await page.waitForFunction(() => (window as any).__engineBridge.renderW === 1280, { timeout: 5_000 });

      // The viewer closing its window turns it off in the show (one undo step).
      await page.evaluate((p: string) => (window as any).arrangementStore.setDisplayEnabled(p, true), pid);
      await page.evaluate((p: string) => (window as any).displayController.setTelemetry(
        undefined, undefined, [{ type: 'closed', placementId: p }]), pid);
      expect(await page.evaluate((p: string) =>
        (window as any).arrangementStore.placementById(p).enabled, pid)).toBe(false);
    });
});
});
