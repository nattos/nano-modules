/**
 * Sidechannel textures E2E (resolume shell, playground mode).
 *
 * Two playground instances stand in for two barrel instances on the shared
 * server: A renders a solid green and publishes it via util.sidechannel_out
 * (channel 2); B is just a util.sidechannel_in on the same channel. B's edit
 * preview must show A's green (REPLACE semantics, cross-instance). Removing
 * A's send must drop B to transparent within a frame (the monitor then shows
 * its checkerboard — grey, not green).
 */
const BASE = process.env.GPU_TEST_BASE_URL || 'http://localhost:5173';

describe('sidechannel textures across playground instances', () => {
  jest.setTimeout(90000);

  it('receive shows the sender instance; removing the sender goes transparent', async () => {
    page.removeAllListeners('console');

    await page.goto(`${BASE}/resolume/index.html?playground`, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 3000));

    // Clean playground, then build sender + receiver instances.
    const ids = await page.evaluate(`(async () => {
      const ac = window.appController;
      for (const inst of [...window.appState.local.barrelInstances]) {
        ac.deletePlaygroundInstanceById(inst.key);
      }
      const a = ac.createPlaygroundInstance();
      const b = ac.createPlaygroundInstance();
      ac.mutate('seed sidechannel', d => {
        d.sketches[a].chain.push(
          { type: 'module', module_type: 'source.solid_color', instance_key: 'green@1' },
          { type: 'module', module_type: 'util.sidechannel_out', instance_key: 'send@1' },
        );
        d.sketches[a].instances['green@1'] =
          { module_type: 'source.solid_color', state: { color: [0.1, 0.9, 0.1, 1] } };
        d.sketches[a].instances['send@1'] =
          { module_type: 'util.sidechannel_out', state: { channel: 2 } };
        d.sketches[b].chain.push(
          { type: 'module', module_type: 'util.sidechannel_in', instance_key: 'recv@1' },
        );
        d.sketches[b].instances['recv@1'] =
          { module_type: 'util.sidechannel_in', state: { channel: 2 } };
      });
      ac.selectBarrelInstance(b);   // open the RECEIVER in the edit tab
      ac.setActiveTab('edit');
      return { a, b };
    })()`) as { a: string; b: string };
    await new Promise(r => setTimeout(r, 3500));

    // Mean RGB of the edit-preview monitor canvas. Transparent output shows
    // the monitor's grey checkerboard (r≈g≈b), so "green dominance" (g − r)
    // cleanly separates content from transparency.
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
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < data.length; i += 4) { r += data[i]; g += data[i+1]; b += data[i+2]; n++; }
      return n ? { r: r / n, g: g / n, b: b / n } : null;
    })()`) as Promise<{ r: number; g: number; b: number } | null>;

    // Receiver shows the sender's green, across instances.
    const fresh = await probe();
    expect(fresh).not.toBeNull();
    expect(fresh!.g - fresh!.r).toBeGreaterThan(60);
    expect(fresh!.g - fresh!.b).toBeGreaterThan(60);

    // The custom inspector decorates channel 2 with the SENDER's instance
    // label ("2 — Instance 1") — select the receive effect and read the
    // dropdown options.
    await page.evaluate(`window.appController.select('effect/${ids.b}/0/0')`);
    await new Promise(r => setTimeout(r, 1200));
    const options = await page.evaluate(`(() => {
      function* walk(root) { for (const el of root.querySelectorAll('*')) { yield el; if (el.shadowRoot) yield* walk(el.shadowRoot); } }
      for (const el of walk(document)) {
        if (el.tagName === 'SIDECHANNEL-INSPECTOR') {
          const texts = [];
          for (const opt of walk(el.shadowRoot)) {
            if (opt.tagName === 'OPTION') texts.push(opt.textContent.trim());
          }
          return texts;
        }
      }
      return null;
    })()`) as string[] | null;
    expect(options).not.toBeNull();
    expect(options!.some(t => /2 — Instance 1/.test(t))).toBe(true);
    expect(options).toContain('Custom');
    await page.evaluate(`window.appController.select(null)`);

    // Wire a texture into the send's secondary `send_in` input: a blue solid
    // prepended to A's chain (the green solid after it still owns the chain
    // image) wired into the send. The OVERRIDE is what gets published — B
    // turns blue — while A's chain output stays green (passthrough).
    await page.evaluate(`(() => {
      const ac = window.appController;
      ac.mutate('wire send override', d => {
        const sk = d.sketches['${ids.a}'];
        sk.chain.unshift(
          { type: 'module', module_type: 'source.solid_color', instance_key: 'blue@1' });
        sk.instances['blue@1'] =
          { module_type: 'source.solid_color', state: { color: [0.1, 0.1, 0.9, 1] } };
        sk.wires.push({ id: 'wovr',
          src:  { instanceKey: 'blue@1', field: 'tex_out' },
          dest: { instanceKey: 'send@1', field: 'send_in' } });
      });
    })()`);
    await new Promise(r => setTimeout(r, 2000));
    const overridden = await probe();
    expect(overridden).not.toBeNull();
    expect(overridden!.b - overridden!.g).toBeGreaterThan(60);   // wired blue arrived
    expect(overridden!.b - overridden!.r).toBeGreaterThan(60);

    // The send card's custom inspector must re-render the texture ports the
    // generic body would have shown — send_in is the wire's attach point.
    await page.evaluate(`window.appController.selectBarrelInstance('${ids.a}')`);
    await new Promise(r => setTimeout(r, 1200));
    const ports = await page.evaluate(`(() => {
      function* walk(root) { for (const el of root.querySelectorAll('*')) { yield el; if (el.shadowRoot) yield* walk(el.shadowRoot); } }
      for (const el of walk(document)) {
        if (el.tagName === 'SIDECHANNEL-INSPECTOR') {
          const out = [];
          for (const p of el.shadowRoot.querySelectorAll('field-placeholder')) {
            out.push(p.fieldPath);
          }
          return out;
        }
      }
      return null;
    })()`) as string[] | null;
    expect(ports).not.toBeNull();
    expect(ports).toContain('tex_in');
    expect(ports).toContain('send_in');
    await page.evaluate(`window.appController.selectBarrelInstance('${ids.b}')`);
    await new Promise(r => setTimeout(r, 1200));

    // Drop the wire → the publish reverts to the chain input (green).
    await page.evaluate(`(() => {
      const ac = window.appController;
      ac.mutate('unwire send override', d => {
        const sk = d.sketches['${ids.a}'];
        sk.wires = sk.wires.filter(w => w.id !== 'wovr');
      });
    })()`);
    await new Promise(r => setTimeout(r, 2000));
    const reverted = await probe();
    expect(reverted).not.toBeNull();
    expect(reverted!.g - reverted!.b).toBeGreaterThan(60);

    // Remove the sender stage from A → the channel goes stale → B transparent
    // (checkerboard: no green dominance).
    await page.evaluate(`(() => {
      const ac = window.appController;
      ac.mutate('remove send', d => {
        const sk = d.sketches['${ids.a}'];
        sk.chain = sk.chain.filter(e => e.instance_key !== 'send@1');
        delete sk.instances['send@1'];
      });
    })()`);
    await new Promise(r => setTimeout(r, 2000));
    const stale = await probe();
    expect(stale).not.toBeNull();
    expect(Math.abs(stale!.g - stale!.r)).toBeLessThan(20);
    expect(Math.abs(stale!.g - stale!.b)).toBeLessThan(20);

    // Cleanup for reruns/other suites.
    await page.evaluate(`(async () => {
      const ac = window.appController;
      for (const inst of [...window.appState.local.barrelInstances]) {
        ac.deletePlaygroundInstanceById(inst.key);
      }
    })()`);
    await new Promise(r => setTimeout(r, 800));
  });
});
