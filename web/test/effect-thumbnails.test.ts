/**
 * Effect-store thumbnail audit: every in-repo effect's preview scenario must
 * bake to something worth looking at.
 *
 * Runs the store's own bake (public/thumb-runner.html → PreviewEngine) over
 * every non-debug effect in the in-repo bundles and flags, per
 * preview/thumb-stats.ts:
 *   - blank          an image or generator thumbnail with (nearly) one colour;
 *   - same-as-input  an image effect whose scene looks the same with the
 *                    effect bypassed (it shows nothing of what it does);
 *   - flat           a modulation effect whose plotted output never moves.
 * A flagged effect needs a (better) preview scenario — see the preview
 * section of EFFECTS_STYLE_GUIDE.md; `npm run thumbs -- --only <id>` renders
 * it to disk. The thumbnails land in /tmp/gpu-test-dumps/thumbs/.
 */
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.GPU_TEST_BASE_URL || 'http://localhost:5173';
const DUMP_DIR = '/tmp/gpu-test-dumps/thumbs';
const IN_REPO = new Set(['com.nano.core', 'com.nano.text', 'com.nano.richtext']);

/** Known exceptions, flag by flag — keep each one justified. */
const ALLOW: Record<string, string[]> = {
  // A flat fill is the whole effect.
  'source.solid_color': ['blank'],
};

interface Audit {
  kind: string;
  flags: string[];
  thumb: { mime: string; dataBase64: string } | null;
}

describe('effect thumbnails', () => {
  jest.setTimeout(240_000);

  it('every in-repo effect bakes a thumbnail that shows it', async () => {
    await page.goto(`${BASE}/thumb-runner.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => !!(window as any).__thumbs, { timeout: 30_000 });
    await page.evaluate(() => (window as any).__thumbs.start());
    const catalog: Array<{ id: string; bundle: string }> = await page.evaluate(() => (window as any).__thumbs.catalog());
    const ids = catalog
      .filter((e) => IN_REPO.has(e.bundle) && !e.id.startsWith('debug.') && !e.id.startsWith('testonly.'))
      .map((e) => e.id)
      .sort();
    expect(ids.length).toBeGreaterThan(50);

    fs.mkdirSync(DUMP_DIR, { recursive: true });
    const problems: string[] = [];
    const kinds: Record<string, string> = {};
    for (const id of ids) {
      const r: Audit = await page.evaluate((x) => (window as any).__thumbs.audit(x), id);
      kinds[id] = r.kind;
      if (r.thumb) {
        const ext = r.thumb.mime === 'image/webp' ? 'webp' : 'png';
        fs.writeFileSync(path.join(DUMP_DIR, `${id}.${ext}`), Buffer.from(r.thumb.dataBase64, 'base64'));
      }
      const flags = r.flags.filter((f) => !(ALLOW[id] ?? []).includes(f));
      if (flags.length) problems.push(`${id} (${r.kind}): ${flags.join(', ')}`);
    }
    expect(problems).toEqual([]);

    // Spot-check the presentation kinds.
    expect(kinds['color.tone.brightness_contrast']).toBe('image');
    expect(kinds['source.noise']).toBe('generator');
    expect(kinds['mod.shaper.remap']).toBe('modulation');
    expect(kinds['util.dashboard']).toBe('icon');
  });
});
