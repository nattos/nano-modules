import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  describeReload, moduleDrift, requestBarrelModuleReload, type ModuleReloadResult,
} from './module-reload';

const result = (over: Partial<ModuleReloadResult>): ModuleReloadResult => ({
  seq: 1, reloaded: [], added: [], removed: [], failed: [], unchanged: 0, ...over,
});

describe('describeReload', () => {
  it('names what moved, by bundle label', () => {
    expect(describeReload({ kind: 'done', result: result({
      reloaded: [{ id: 'com.nano.nano', path: '/dev/nano.wasm', from: '/deployed/nano.wasm' }],
      removed: [{ id: 'com.nano.mine', path: '/x/mine.wasm' }],
    }) })).toBe('Resolume reloaded Nano; removed mine.');
  });

  it('says so when nothing changed, and keeps a failed copy honest', () => {
    expect(describeReload({ kind: 'done', result: result({ unchanged: 3 }) }))
      .toMatch(/nothing changed/);
    expect(describeReload({ kind: 'done', result: result({
      failed: [{ id: 'com.nano.lights', path: '/l/lights.wasm' }],
    }) })).toBe("Resolume couldn't load Lights (kept the old copy).");
  });

  it('tells a queued request from an unreachable server', () => {
    expect(describeReload({ kind: 'queued' })).toMatch(/next frame/);
    expect(describeReload({ kind: 'unreachable' })).toMatch(/Couldn't reach/);
  });
});

describe('moduleDrift', () => {
  it('flags a dev folder the app uses and Resolume has not picked up', () => {
    const app = [
      { id: 'com.nano.core', path: '/app/wasm/core.wasm', origin: 'builtin' },
      { id: 'com.nano.nano', path: '/dev/nano.wasm', origin: 'mapped' },
    ];
    const resolume = [
      { id: 'com.nano.core', path: '/Resolume/plugin/wasm/core.wasm', origin: 'builtin' },
      { id: 'com.nano.nano', path: '/deployed/nano.wasm', origin: 'mapped' },
    ];
    expect(moduleDrift(app, resolume)).toEqual([
      { id: 'com.nano.nano', app: '/dev/nano.wasm', resolume: '/deployed/nano.wasm' },
    ]);
  });

  it('ignores built-ins living in different resource roots, and matching copies', () => {
    const app = [
      { id: 'com.nano.core', path: '/a/core.wasm', origin: 'builtin' },
      { id: 'com.nano.nano', path: 'C:\\m\\nano.wasm', origin: 'default' },
    ];
    const resolume = [
      { id: 'com.nano.core', path: '/b/core.wasm', origin: 'builtin' },
      { id: 'com.nano.nano', path: 'C:/m/nano.wasm', origin: 'default' },
    ];
    expect(moduleDrift(app, resolume)).toEqual([]);
  });

  it('reports a bundle only one side has', () => {
    expect(moduleDrift(
      [{ id: 'com.nano.mine', path: '/dev/mine.wasm', origin: 'mapped' }],
      [],
    )).toEqual([{ id: 'com.nano.mine', app: '/dev/mine.wasm', resolume: null }]);
  });
});

/** Just enough of the bridge: `get` answers a snapshot, `reload_modules` bumps
 *  the published result after `serveAfter` polls (a frame has to render). */
class FakeBridge {
  static instances: FakeBridge[] = [];
  static serveAfter = 2;
  static reachable = true;
  static seq = 4;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: any[] = [];
  private pending = -1;
  constructor(public url: string) {
    FakeBridge.instances.push(this);
    setTimeout(() => (FakeBridge.reachable ? this.onopen?.() : this.onerror?.()), 0);
  }
  send(raw: string) {
    const msg = JSON.parse(raw);
    this.sent.push(msg);
    if (msg.action === 'reload_modules') this.pending = FakeBridge.serveAfter;
    if (msg.action === 'get') {
      if (this.pending === 0) { FakeBridge.seq++; this.pending = -1; }
      else if (this.pending > 0) this.pending--;
      const data = result({ seq: FakeBridge.seq, unchanged: 2 });
      setTimeout(() => this.onmessage?.({ data: JSON.stringify(
        { type: 'snapshot', path: '/global/modules_reload', data }) }), 0);
    }
  }
  close() { /* the caller is done */ }
}

describe('requestBarrelModuleReload', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeBridge.instances = [];
    FakeBridge.reachable = true;
  });

  it('sends reload_modules and waits for a NEWER result than the one before', async () => {
    vi.stubGlobal('WebSocket', FakeBridge);
    const o = await requestBarrelModuleReload('ws://x', 3000);
    expect(o.kind).toBe('done');
    if (o.kind === 'done') expect(o.result.seq).toBe(5);
    expect(FakeBridge.instances[0].sent.filter((m) => m.action === 'reload_modules')).toHaveLength(1);
  });

  it('reports queued when no frame serves it in time, unreachable when nothing answers', async () => {
    vi.stubGlobal('WebSocket', FakeBridge);
    FakeBridge.serveAfter = 1e9;
    expect((await requestBarrelModuleReload('ws://x', 400)).kind).toBe('queued');
    FakeBridge.serveAfter = 2;
    FakeBridge.reachable = false;
    expect((await requestBarrelModuleReload('ws://x', 400)).kind).toBe('unreachable');
  });
});
