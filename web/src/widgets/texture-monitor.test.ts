// @vitest-environment happy-dom
/**
 * <texture-monitor> pause semantics: when `paused`, the monitor unregisters its
 * trace (stops requesting frames) — the Live-mode play/pause lever that halts
 * the main full-res readback + WS fan-out — and re-registers when unpaused.
 */
import { describe, it, expect, afterEach } from 'vitest';
import './texture-monitor';
import type { TextureMonitor } from './texture-monitor';
import type { TraceSource, TraceRegistration } from '../state/trace-controller';

function makeSource() {
  const ids = new Set<string>();
  const source: TraceSource = {
    register(reg: TraceRegistration) { ids.add(reg.id); },
    unregister(id: string) { ids.delete(id); },
    frame() { return undefined; },
    generation: 0,
  };
  return { source, ids };
}

async function mount(source: TraceSource, paused = false): Promise<TextureMonitor> {
  const el = document.createElement('texture-monitor') as TextureMonitor;
  el.traceId = 'tm-test';
  el.traceTarget = { type: 'sketch_output', sketchId: 'sk' } as any;
  el.fullRes = true;
  el.resolution = 'high';
  el.eager = true; // register on first render regardless of IntersectionObserver
  el.traceSource = source;
  el.paused = paused;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe('<texture-monitor> pause', () => {
  let el: TextureMonitor;
  afterEach(() => { el?.remove(); });

  it('registers a trace while running', async () => {
    const { source, ids } = makeSource();
    el = await mount(source);
    expect(ids.has('tm-test')).toBe(true);
  });

  it('unregisters when paused, re-registers when unpaused', async () => {
    const { source, ids } = makeSource();
    el = await mount(source);
    expect(ids.has('tm-test')).toBe(true);

    el.paused = true;
    await el.updateComplete;
    expect(ids.has('tm-test')).toBe(false);

    el.paused = false;
    await el.updateComplete;
    expect(ids.has('tm-test')).toBe(true);
  });

  it('never registers when mounted already paused', async () => {
    const { source, ids } = makeSource();
    el = await mount(source, true);
    expect(ids.has('tm-test')).toBe(false);
  });
});
