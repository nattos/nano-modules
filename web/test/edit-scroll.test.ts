/**
 * Edit-tab column scroll regression (resolume shell, playground mode).
 *
 * The columns-view scroll container must stay pinned to the viewport height.
 * Its scroll-past-end tail sizes the content to ~clientHeight×1.5, so if any
 * ancestor in the left panel's flex chain loses its min-height:0 pin, the
 * container's height feeds back on itself and diverges to the browser's
 * ~16.7M px element-height clamp — visually "scroll stops working" (the
 * container IS its content; nothing overflows). Guards edit-tab's
 * `.columns-wrap { min-height: 0 }`.
 */
const BASE = process.env.GPU_TEST_BASE_URL || 'http://localhost:5173';

describe('edit tab column scrolling', () => {
  jest.setTimeout(60000);

  it('keeps the scroll container viewport-bound and scrollable', async () => {
    page.removeAllListeners('console');

    await page.goto(`${BASE}/resolume/index.html?playground`, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 3000));

    // One instance with a chain long enough to overflow the viewport.
    await page.evaluate(`(async () => {
      const ac = window.appController;
      for (const inst of [...window.appState.local.barrelInstances]) {
        ac.deletePlaygroundInstanceById(inst.key);
      }
      const a = ac.createPlaygroundInstance();
      ac.mutate('long chain', d => {
        for (let i = 0; i < 12; i++) {
          d.sketches[a].chain.push(
            { type: 'module', module_type: 'color.invert', instance_key: 'inv@' + i });
          d.sketches[a].instances['inv@' + i] = { module_type: 'color.invert', state: {} };
        }
      });
      ac.setActiveTab('edit');
    })()`);
    await new Promise(r => setTimeout(r, 2500));

    const scroll = await page.evaluate(`(() => {
      function* walk(root) { for (const el of root.querySelectorAll('*')) { yield el; if (el.shadowRoot) yield* walk(el.shadowRoot); } }
      let sc = null;
      for (const el of walk(document)) {
        if (el.classList && el.classList.contains('scroll-container')) { sc = el; break; }
      }
      if (!sc) return null;
      const before = sc.scrollTop;
      sc.scrollTop = 300;
      return {
        clientHeight: sc.clientHeight,
        scrollHeight: sc.scrollHeight,
        before,
        after: sc.scrollTop,
      };
    })()`) as { clientHeight: number; scrollHeight: number; before: number; after: number } | null;

    expect(scroll).not.toBeNull();
    // Viewport-bound: a diverged container reads ~16.7M px here.
    expect(scroll!.clientHeight).toBeLessThan(2000);
    // Overflowing content, and scrollTop actually moves.
    expect(scroll!.scrollHeight).toBeGreaterThan(scroll!.clientHeight + 200);
    expect(scroll!.after).toBe(300);

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
