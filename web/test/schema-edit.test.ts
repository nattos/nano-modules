/**
 * Schema-edit infrastructure E2E.
 *
 * Effects register every parameter in init() and use
 * `state::setFieldHidden` to gate which ones the IDE shows. The signal
 * fires once via `state::setOnStateReady` after init + the initial
 * state replay, and again from `on_state_patched` whenever a
 * mode-selector field changes. The IDE never paints the intermediate
 * "all fields visible" state.
 *
 * `warp.crop` is the canonical user of this pattern (Span vs Inset
 * mode), so we drive it directly through a WasmHost and inspect
 * `host.hiddenFields`.
 */

describe('Schema-edit lifecycle (setFieldHidden + on_state_ready)', () => {
  jest.setTimeout(30000);

  it('crop: default Span hides inset fields, mode toggle flips visibility', async () => {
    page.on('console', (msg) => console.log('[browser]', msg.text()));
    await page.goto('http://localhost:5173/gpu-test-runner.html', { waitUntil: 'networkidle0' });

    const result = await page.evaluate(`(async () => {
      const { GPUHost } = await import('/src/gpu-host.ts');
      const { WasmHost } = await import('/src/wasm-host.ts');
      const adapter = await navigator.gpu.requestAdapter();
      const device = await adapter.requestDevice();
      const gpuHost = new GPUHost(device, 'rgba8unorm');
      const tex = device.createTexture({
        size: [16, 16], format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
             | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
      });
      gpuHost.setSurface(tex, 16, 16);

      const host = new WasmHost();
      host.gpuHost = gpuHost;
      host.textureFields.set('tex_in', gpuHost.injectTexture(tex));
      host.textureFields.set('tex_out', gpuHost.injectTexture(tex));

      await host.load('/wasm/core.wasm');
      const mod = host.activateEffect('warp.crop');
      const beforeReady = Array.from(host.hiddenFields).sort();

      // Fire the on_state_ready signal — production path runs this in
      // the executor after replaying any restored state. With nothing
      // to restore, mode stays at the default (Span).
      host.fireStateReady();
      const afterReady = Array.from(host.hiddenFields).sort();

      // User toggles mode → Inset (emulates the dropdown patch).
      host.notifyStatePatched(mod, [{ op: 'replace', path: 'mode', value: 1 }]);
      const afterInset = Array.from(host.hiddenFields).sort();

      // User toggles back to Span.
      host.notifyStatePatched(mod, [{ op: 'replace', path: 'mode', value: 0 }]);
      const afterSpan = Array.from(host.hiddenFields).sort();

      // fireStateReady is one-shot — calling again should be a no-op.
      host.fireStateReady();
      const afterRefire = Array.from(host.hiddenFields).sort();

      return { beforeReady, afterReady, afterInset, afterSpan, afterRefire };
    })()`);

    const r = result as any;
    // Before the on_state_ready signal: visibility hasn't been computed.
    expect(r.beforeReady).toEqual([]);
    // After fireStateReady at the default (Span): inset fields hidden.
    expect(r.afterReady).toEqual(['inset_bottom', 'inset_left', 'inset_right', 'inset_top']);
    // After user patches mode=Inset: span fields hidden instead.
    expect(r.afterInset).toEqual(['center', 'height', 'width']);
    // Toggling back to Span re-hides the inset fields.
    expect(r.afterSpan).toEqual(['inset_bottom', 'inset_left', 'inset_right', 'inset_top']);
    // fireStateReady is idempotent — second call is a no-op.
    expect(r.afterRefire).toEqual(r.afterSpan);
  });

  it('field-select: renders the bound value selected at first paint (not the first option)', async () => {
    // Regression: lit applies element properties before child <option>s
    // are appended, so `<select .value=...>` couldn't find the matching
    // option and silently fell back to the first one. We declare
    // `?selected` per option instead, which is order-independent.
    page.on('console', (msg) => console.log('[browser]', msg.text()));
    await page.goto('http://localhost:5173/gpu-test-runner.html', { waitUntil: 'networkidle0' });
    const result = await page.evaluate(`(async () => {
      await import('/src/widgets/field-select.ts');
      const sel = document.createElement('field-select');
      sel.fieldPath = 'mode';
      sel.label = 'mode';
      sel.options = [{ label: 'Span', value: 0 }, { label: 'Inset', value: 1 }];
      sel.defaultValue = 0;
      // Binding starts at the non-default option — this is the case
      // that broke before the fix (always rendered as Span).
      sel.binding = { instanceKey: 'p', getValue: () => 1, setValue: () => {} };
      document.body.appendChild(sel);
      await new Promise(r => setTimeout(r, 50));
      const inner = sel.shadowRoot.querySelector('select');
      const out = { selectValue: inner.value, selectedIndex: inner.selectedIndex,
                    selectedOptionLabel: inner.options[inner.selectedIndex]?.text };
      sel.remove();
      return out;
    })()`);
    const r = result as any;
    expect(r.selectValue).toBe('1');
    expect(r.selectedIndex).toBe(1);
    expect(r.selectedOptionLabel).toBe('Inset');
  });

  it('field-tab-bar: clicking an option writes the typed value and triggers visibility flip', async () => {
    // field-tab-bar is the default editor for select-type fields.
    // Same correctness contract as field-select, but with a single
    // click on a row of buttons instead of a dropdown menu.
    page.on('console', (msg) => console.log('[browser]', msg.text()));
    await page.goto('http://localhost:5173/gpu-test-runner.html', { waitUntil: 'networkidle0' });

    const result = await page.evaluate(`(async () => {
      const { GPUHost } = await import('/src/gpu-host.ts');
      const { WasmHost } = await import('/src/wasm-host.ts');
      await import('/src/widgets/field-tab-bar.ts');

      const adapter = await navigator.gpu.requestAdapter();
      const device = await adapter.requestDevice();
      const gpuHost = new GPUHost(device, 'rgba8unorm');
      const tex = device.createTexture({
        size: [16, 16], format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
             | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
      });
      gpuHost.setSurface(tex, 16, 16);

      const host = new WasmHost();
      host.gpuHost = gpuHost;
      host.textureFields.set('tex_in', gpuHost.injectTexture(tex));
      host.textureFields.set('tex_out', gpuHost.injectTexture(tex));
      await host.load('/wasm/core.wasm');
      const mod = host.activateEffect('warp.crop');
      host.fireStateReady();

      const captured = [];
      const binding = {
        instanceKey: 'probe',
        getValue: () => 0,
        setValue: (path, value) => {
          captured.push({ path, value, type: typeof value });
          host.notifyStatePatched(mod, [{ op: 'replace', path, value }]);
        },
      };

      const tb = document.createElement('field-tab-bar');
      tb.fieldPath = 'mode';
      tb.label = 'mode';
      tb.options = [{ label: 'Span', value: 0 }, { label: 'Inset', value: 1 }];
      tb.defaultValue = 0;
      tb.binding = binding;
      document.body.appendChild(tb);
      await new Promise(r => setTimeout(r, 50));

      // Confirm the default option is highlighted before any click.
      const buttonsBefore = Array.from(tb.shadowRoot.querySelectorAll('button'));
      const activeBefore = buttonsBefore.find(b => b.hasAttribute('active')).textContent;

      // Click "Inset".
      buttonsBefore[1].click();
      await new Promise(r => setTimeout(r, 50));
      const buttonsAfter = Array.from(tb.shadowRoot.querySelectorAll('button'));
      const activeAfter = buttonsAfter.find(b => b.hasAttribute('active'))?.textContent ?? null;

      const hidden = Array.from(host.hiddenFields).sort();
      tb.remove();
      return { captured, activeBefore, activeAfter, hidden };
    })()`);

    const r = result as any;
    // Default option (Span) was highlighted before any click.
    expect(r.activeBefore).toBe('Span');
    // Click sent the typed value (number 1, not the string "1").
    expect(r.captured).toEqual([{ path: 'mode', value: 1, type: 'number' }]);
    // After the click, "Inset" is the active button (binding.getValue
    // returned 1 via the captured patch's effect on host state — the
    // mock binding here returns 0 statically so we only verify the
    // visibility flip; see the next test for end-to-end re-render).
    expect(r.hidden).toEqual(['center', 'height', 'width']);
  });

  it('field-select: dropdown click writes the typed value and triggers visibility flip', async () => {
    // <select>.value is always a string; the widget converts back to
    // the option's typed value before writing. Without this, mode
    // patches arrive as strings and C++'s `state::patchFloat` (via
    // val::asNumber) silently coerces them to 0 — visibility never
    // flips and the value gets clobbered on the next replay.
    page.on('console', (msg) => console.log('[browser]', msg.text()));
    await page.goto('http://localhost:5173/gpu-test-runner.html', { waitUntil: 'networkidle0' });

    const result = await page.evaluate(`(async () => {
      const { GPUHost } = await import('/src/gpu-host.ts');
      const { WasmHost } = await import('/src/wasm-host.ts');
      await import('/src/widgets/field-select.ts');

      const adapter = await navigator.gpu.requestAdapter();
      const device = await adapter.requestDevice();
      const gpuHost = new GPUHost(device, 'rgba8unorm');
      const tex = device.createTexture({
        size: [16, 16], format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
             | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
      });
      gpuHost.setSurface(tex, 16, 16);

      const host = new WasmHost();
      host.gpuHost = gpuHost;
      host.textureFields.set('tex_in', gpuHost.injectTexture(tex));
      host.textureFields.set('tex_out', gpuHost.injectTexture(tex));
      await host.load('/wasm/core.wasm');
      const mod = host.activateEffect('warp.crop');
      host.fireStateReady();

      const captured = [];
      const binding = {
        instanceKey: 'probe',
        getValue: () => 0,
        setValue: (path, value) => {
          captured.push({ path, value, type: typeof value });
          host.notifyStatePatched(mod, [{ op: 'replace', path, value }]);
        },
      };

      const sel = document.createElement('field-select');
      sel.fieldPath = 'mode';
      sel.label = 'mode';
      sel.options = [{ label: 'Span', value: 0 }, { label: 'Inset', value: 1 }];
      sel.defaultValue = 0;
      sel.binding = binding;
      document.body.appendChild(sel);
      await new Promise(r => setTimeout(r, 50));
      const innerSelect = sel.shadowRoot.querySelector('select');
      innerSelect.value = '1';
      innerSelect.dispatchEvent(new Event('change'));

      const hidden = Array.from(host.hiddenFields).sort();
      sel.remove();
      return { captured, hidden };
    })()`);

    const r = result as any;
    // Payload reaches the binding as a number (typed), not the
    // raw "1" string.
    expect(r.captured).toEqual([{ path: 'mode', value: 1, type: 'number' }]);
    // Crop's on_state_patched updates s_mode, calls
    // apply_mode_visibility() — span fields hidden in Inset mode.
    expect(r.hidden).toEqual(['center', 'height', 'width']);
  });

  it('crop: state replay before fireStateReady → visibility reflects restored mode', async () => {
    // Production path on a "loaded project saved with mode=Inset":
    //   1. ensureInstance creates the host, init() registers all fields
    //   2. executor replays patches, including mode=1
    //   3. executor calls fireStateReady → on_state_ready uses the
    //      restored mode value (not the init default) when deciding
    //      visibility. The IDE never sees the Span layout.
    page.on('console', (msg) => console.log('[browser]', msg.text()));
    await page.goto('http://localhost:5173/gpu-test-runner.html', { waitUntil: 'networkidle0' });

    const result = await page.evaluate(`(async () => {
      const { GPUHost } = await import('/src/gpu-host.ts');
      const { WasmHost } = await import('/src/wasm-host.ts');
      const adapter = await navigator.gpu.requestAdapter();
      const device = await adapter.requestDevice();
      const gpuHost = new GPUHost(device, 'rgba8unorm');
      const tex = device.createTexture({
        size: [16, 16], format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
             | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
      });
      gpuHost.setSurface(tex, 16, 16);

      const host = new WasmHost();
      host.gpuHost = gpuHost;
      host.textureFields.set('tex_in', gpuHost.injectTexture(tex));
      host.textureFields.set('tex_out', gpuHost.injectTexture(tex));

      await host.load('/wasm/core.wasm');
      const mod = host.activateEffect('warp.crop');

      // Replay a saved state with mode=Inset BEFORE firing on_state_ready.
      host.notifyStatePatched(mod, [{ op: 'replace', path: 'mode', value: 1 }]);
      // on_state_patched already calls apply_mode_visibility on mode
      // changes, so visibility tracks the restored value here:
      const afterReplay = Array.from(host.hiddenFields).sort();

      // fireStateReady runs with the restored mode → reaffirms.
      host.fireStateReady();
      const afterReady = Array.from(host.hiddenFields).sort();

      return { afterReplay, afterReady };
    })()`);

    const r = result as any;
    // Inset mode → span fields hidden (center, height, width).
    expect(r.afterReplay).toEqual(['center', 'height', 'width']);
    // fireStateReady didn't re-introduce stale visibility.
    expect(r.afterReady).toEqual(['center', 'height', 'width']);
  });
});
