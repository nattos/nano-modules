/**
 * streams-probe.test.ts — the seekable-streams ABI end-to-end on the WEB host:
 * the REAL testonly.streams_probe wasm effect runs under WasmHost's actual
 * importObject, reads the streams.* imports against a StreamsRegistry loaded
 * from the shared golden, and republishes what it saw. Assertion values mirror
 * native/tests/test_streams_probe.cpp — the two suites are the integration
 * halves of the same contract.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WasmHost } from './wasm-host';
import { StreamsRegistry } from './streams-registry';

const TESTONLY = resolve(__dirname, '../public/wasm/testonly.wasm');
const GOLDEN = resolve(__dirname, '../../native/tests/fixtures/comp/streams-golden.json');

// The fixture doc is unwarped at 120 BPM → 0.5 s/beat.
const secondsAt = (beat: number) => beat * 0.5;

async function loadProbe(): Promise<{ host: WasmHost; mod: import('./wasm-host').WasmModule }> {
  const host = new WasmHost();
  const compiled = await WebAssembly.compile(readFileSync(TESTONLY) as BufferSource);
  await host.load(compiled);
  const mod = host.activateEffect('testonly.streams_probe');
  return { host, mod };
}

describe('streams probe through the real wasm effect (web host)', () => {
  it('answers the session-clock-only world without a registry', async () => {
    const { host, mod } = await loadProbe();
    host.frameState.elapsedTime = 7.25;
    mod.tick(0.016);
    const st = host.pluginState;
    expect(st.seen_parent_kind).toBe(1);      // KindSessionClock
    expect(st.seen_parent_pos).toBe(7.25);
    expect(st.seen_parent_playing).toBe(1);
    expect(st.seen_content_kind).toBe(-1);
    expect(st.seen_event_count).toBe(0);
    expect(st.seen_rev).toBe(0);
    expect(st.seen_stream_count).toBe(1);
    expect(st.transport_time_sec).toBe(7.25); // rate(1) x parent seconds
  });

  it('answers the full registry world identically to native', async () => {
    const { host, mod } = await loadProbe();
    const reg = new StreamsRegistry();
    reg.loadStatic(JSON.parse(readFileSync(GOLDEN, 'utf8')), secondsAt);
    reg.frame.posBeat = 10;
    reg.frame.posSec = 5;
    reg.frame.playing = 1;
    host.streams = reg;
    host.instanceKey = 'clip_clipB_transport_dev1';
    host.frameState.elapsedTime = 99; // must NOT leak through the registry

    mod.tick(0.016);
    let st = host.pluginState;
    expect(st.seen_parent_kind).toBe(3);      // KindTimelineTrack (trackA)
    expect(st.seen_parent_pos).toBe(10);      // transport beat
    expect(st.seen_parent_playing).toBe(1);
    expect(st.seen_content_kind).toBe(5);     // KindVideoContent
    // clipB 'time' mode anchored at beat 8 → 1 real second in at 120 BPM.
    expect(st.seen_content_pos).toBeCloseTo(1.0, 9);
    expect(st.seen_event_count).toBe(4);
    expect(st.seen_first_time).toBe(0);
    expect(st.seen_first_channel).toBe(-1);   // NaN channel → sentinel
    expect(st.seen_rev).toBe(7);
    expect(st.seen_stream_count).toBe(4);
    expect(st.transport_time_sec).toBe(5);    // rate(1) x parent posSec

    // A transport-controller override re-routes the content position 1:1.
    reg.appliedContentSec.set('clipB', 3.5);
    mod.tick(0.016);
    st = host.pluginState;
    expect(st.seen_content_pos).toBe(3.5);

    // A non-clip key scopes to the session clock even with a registry.
    host.instanceKey = 'track_t1_dev';
    mod.tick(0.016);
    st = host.pluginState;
    expect(st.seen_parent_kind).toBe(1);
    expect(st.seen_content_kind).toBe(-1);
  });
});
