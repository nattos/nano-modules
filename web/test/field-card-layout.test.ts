/**
 * Floating field-card placement E2E (resolume shell, playground mode).
 *
 * The <taps-overlay> field card anchors beside the column when there's room.
 * In a NARROW view (the arrangement panel's normal shape) neither side fits,
 * and the bounds clamp used to slide the card back dead-center over the
 * selected field — obscuring the very row (and connect port) being inspected.
 * Now it dodges vertically instead. This drives the real overlay at a narrow
 * viewport and asserts the card never covers the selected field's row.
 */
const BASE = process.env.GPU_TEST_BASE_URL || 'http://localhost:5173';

describe('field card placement (narrow view)', () => {
  jest.setTimeout(50000);

  it('does not cover the selected field row when no side fits', async () => {
    page.removeAllListeners('console');

    await page.setViewport({ width: 520, height: 800 });
    try {
      await page.goto(`${BASE}/resolume/index.html?playground`, { waitUntil: 'networkidle0' });
      await new Promise(r => setTimeout(r, 3000));

      await page.evaluate(`(async () => {
        const ac = window.appController;
        ac.mutate('s', d => {
          d.sketches['sk_fc'] = {
            anchor: null,
            chain: [
              { type: 'module', module_type: 'mod.source.lfo', instance_key: 'lfo@0' },
              { type: 'module', module_type: 'color.tone.brightness_contrast', instance_key: 'bc@0' },
            ],
            wires: [{ id: 'w0', src: { instanceKey: 'lfo@0', field: 'output' },
                      dest: { instanceKey: 'bc@0', field: 'brightness' } }],
            instances: {
              'lfo@0': { module_type: 'mod.source.lfo', state: {} },
              'bc@0': { module_type: 'color.tone.brightness_contrast', state: { brightness: 1, contrast: 0.25 } },
            },
          };
        });
        ac.setActiveTab('edit');
        ac.editSketch('sk_fc');
        ac.setTappingMode(true);
      })()`);
      await new Promise(r => setTimeout(r, 1500));

      // Select the wire → the card shows for its DEST field (bc@0.brightness).
      await page.evaluate(`(() => {
        function* walk(root){for(const el of root.querySelectorAll('*')){yield el; if(el.shadowRoot) yield* walk(el.shadowRoot);}}
        for (const el of walk(document)) {
          if (el.tagName === 'TAPS-OVERLAY') {
            el.shadowRoot.querySelector('.wire-hit')
              .dispatchEvent(new MouseEvent('click', { bubbles: true }));
            return;
          }
        }
      })()`);
      // A few rAFs so the imperative positioner has settled.
      await new Promise(r => setTimeout(r, 600));

      const geom = await page.evaluate(`(() => {
        function* walk(root){for(const el of root.querySelectorAll('*')){yield el; if(el.shadowRoot) yield* walk(el.shadowRoot);}}
        let overlay = null;
        for (const el of walk(document)) if (el.tagName === 'TAPS-OVERLAY') overlay = el;
        if (!overlay) return { error: 'no overlay' };
        const card = overlay.shadowRoot.querySelector('.field-card');
        if (!card) return { error: 'no card' };
        // The anchor row: the dest field's tap-port hit-box (same selector the
        // overlay's own fieldHitIn uses), else its gutter option pip.
        const hitSel = '.tap-overlay-hit[data-col-idx="0"][data-chain-idx="1"][data-field-path="brightness"]';
        let hit = null;
        for (const el of walk(document)) {
          if (el.matches && (el.matches(hitSel)
              || (el.classList.contains('field-option-pip')
                  && el.dataset.fieldKey === 'sk_fc/0/1/brightness'))) { hit = el; break; }
        }
        if (!hit) return { error: 'no field anchor' };
        const c = card.getBoundingClientRect();
        const f = hit.getBoundingClientRect();
        const o = overlay.getBoundingClientRect();
        const col = hit.closest('.column');
        const colR = col ? col.getBoundingClientRect() : f;
        return {
          card: { left: c.left, right: c.right, top: c.top, bottom: c.bottom, width: c.width },
          field: { left: f.left, right: f.right, top: f.top, bottom: f.bottom },
          overlay: { left: o.left, right: o.right, width: o.width },
          column: { left: colR.left, right: colR.right },
          visible: getComputedStyle(card).visibility,
        };
      })()`) as any;

      expect(geom.error).toBeUndefined();
      expect(geom.visible).toBe('visible');
      // Precondition for the regression: neither side of the column has room
      // for the card (the exact condition the overlay checks) — otherwise this
      // test silently stops covering the clamped path.
      expect(geom.column.right + 12 + geom.card.width).toBeGreaterThan(geom.overlay.right);
      expect(geom.column.left - 12 - geom.card.width).toBeLessThan(geom.overlay.left);
      // The card must not overlap the selected field's row rect.
      const overlaps =
        geom.card.left < geom.field.right && geom.card.right > geom.field.left &&
        geom.card.top < geom.field.bottom && geom.card.bottom > geom.field.top;
      expect(overlaps).toBe(false);
    } finally {
      await page.setViewport({ width: 1280, height: 900 });
    }
  });
});
