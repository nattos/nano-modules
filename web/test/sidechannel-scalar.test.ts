/**
 * Scalar (value) sidechannels E2E (resolume shell, playground mode).
 *
 * The scalar twin of sidechannel.test.ts, and in the same shell for the same
 * reason: the engine testbed only loads the `testonly` bundle, which carries no
 * util.* effects — cross-instance sidechannels are only reachable through two
 * real playground instances (which stand in for two barrel instances on the
 * shared server).
 *
 * A publishes 0.8 on value channel 2. B receives it and wires it into
 * brightness_contrast.brightness in `absolute` magnitude (raw pass-through), so
 * the value becomes VISIBLE: on a white solid with contrast −0.5 the output is
 * (1 + brightness) * 0.5 —
 *     sent 0.8 → 0.9 → ~229
 *     stale   → 0.0 → 0.5 → ~128 (mid gray)
 * Removing the sender is the interesting half: a channel that goes quiet must
 * fall back to 0.0 within a frame (the unplugged-cable contract) rather than
 * latching the last value it saw.
 */
const BASE = process.env.GPU_TEST_BASE_URL || 'http://localhost:5173';

describe('scalar sidechannels across playground instances', () => {
  jest.setTimeout(90000);

  it('a value crosses instances; removing the sender falls back to 0', async () => {
    page.removeAllListeners('console');

    await page.goto(`${BASE}/resolume/index.html?playground`, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 3000));

    const ids = await page.evaluate(`(async () => {
      const ac = window.appController;
      for (const inst of [...window.appState.local.barrelInstances]) {
        ac.deletePlaygroundInstanceById(inst.key);
      }
      const a = ac.createPlaygroundInstance();
      const b = ac.createPlaygroundInstance();
      ac.mutate('seed scalar sidechannel', d => {
        // A: publish 0.8 on value channel 2 (a knob-only send — no wire in).
        d.sketches[a].chain.push(
          { type: 'module', module_type: 'util.sidechannel_scalar_out', instance_key: 'send@1' },
        );
        d.sketches[a].instances['send@1'] =
          { module_type: 'util.sidechannel_scalar_out', state: { channel: 2, value: 0.8 } };
        // B: white → receive(ch 2) → brightness, with the received value wired
        // into brightness raw, so the pixel reports the value.
        d.sketches[b].chain.push(
          { type: 'module', module_type: 'source.solid_color', instance_key: 'white@1' },
          { type: 'module', module_type: 'util.sidechannel_scalar_in', instance_key: 'recv@1' },
          { type: 'module', module_type: 'color.tone.brightness_contrast', instance_key: 'bc@1' },
        );
        d.sketches[b].instances['white@1'] =
          { module_type: 'source.solid_color', state: { color: [1, 1, 1, 1] } };
        d.sketches[b].instances['recv@1'] =
          { module_type: 'util.sidechannel_scalar_in', state: { channel: 2 } };
        d.sketches[b].instances['bc@1'] =
          { module_type: 'color.tone.brightness_contrast',
            state: { brightness: 0.0, contrast: -0.5 } };
        d.sketches[b].wires.push({ id: 'wval',
          src:  { instanceKey: 'recv@1', field: 'value' },
          dest: { instanceKey: 'bc@1', field: 'brightness' },
          combine: 'replace', magnitude: 'absolute' });
      });
      ac.selectBarrelInstance(b);   // open the RECEIVER in the edit tab
      ac.setActiveTab('edit');
      return { a, b };
    })()`) as { a: string; b: string };
    await new Promise(r => setTimeout(r, 3500));

    // Mean RGB of the edit-preview monitor canvas.
    const probe = () => page.evaluate(`(() => {
      function* walk(root) { for (const el of root.querySelectorAll('*')) { yield el; if (el.shadowRoot) yield* walk(el.shadowRoot); } }
      let monitor = null;
      for (const el of walk(document)) { if (el.tagName === 'SKETCH-MONITOR') { monitor = el; break; } }
      let canvas = null;
      if (monitor?.shadowRoot) {
        for (const el of walk(monitor.shadowRoot)) { if (el.tagName === 'CANVAS') { canvas = el; break; } }
      }
      if (!canvas) return null;
      const ctx = canvas.getContext('2d');
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let r = 0, n = 0;
      for (let i = 0; i < data.length; i += 4) { r += data[i]; n++; }
      return n ? r / n : null;
    })()`) as Promise<number | null>;

    // The sent 0.8 arrived: brightness 0.8 → ~229, far above the unmodulated 128.
    const fresh = await probe();
    expect(fresh).not.toBeNull();
    expect(Math.abs(fresh! - 229)).toBeLessThan(14);

    // The channel is surfaced as bus metadata (the Instances tab's Value
    // Sidechannels grid reads exactly this), attributed to the SENDER.
    const meta = await page.evaluate(`(() => {
      const sc = window.appState.local.engine.scalarSidechannels || {};
      return { channels: Object.keys(sc), writer: sc['2'] ? sc['2'].writer : null };
    })()`) as { channels: string[]; writer: string | null };
    expect(meta.channels).toContain('2');
    expect(meta.writer).toBe(ids.a);

    // Remove the sender stage from A → the channel goes quiet → the receive
    // falls back to 0.0, so brightness returns to neutral (mid gray). A latched
    // value would still read ~229 here.
    await page.evaluate(`(() => {
      window.appController.mutate('drop the send', d => {
        const sk = d.sketches['${ids.a}'];
        sk.chain = sk.chain.filter(e => e.instance_key !== 'send@1');
      });
    })()`);
    await new Promise(r => setTimeout(r, 2500));
    const stale = await probe();
    expect(stale).not.toBeNull();
    expect(Math.abs(stale! - 128)).toBeLessThan(14);
  });
});
