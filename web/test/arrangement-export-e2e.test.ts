/**
 * GPU e2e: OFFLINE EXPORT renders a real composition (solid + effect + real
 * h264 video clip) to an MP4 blob — end-to-end through the SECOND engine
 * worker's own comp executor (paused, seek-stepped per frame), the
 * deterministic ExportVideoPump, WebCodecs encode, and mp4-muxer. Pins that
 * two comp executors (live preview + export) coexist on one page.
 *
 *   GPU_TEST_BASE_URL=http://localhost:5174 npx jest arrangement-export-e2e
 */

const BASE = process.env.GPU_TEST_BASE_URL || process.env.ARR_BASE_URL || 'http://localhost:5173';
const URL = `${BASE}/arrangement.html`;

async function runExport(url: string): Promise<{ frames: number; engineFrames: number; blobSize: number; durationSec: number }> {
  const errors: string[] = [];
  page.removeAllListeners('pageerror');
  page.removeAllListeners('console');
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const t = msg.text();
    if (t.includes('Failed to load resource')) return;
    errors.push(`[console] ${t}`);
  });

  await page.goto(url, { waitUntil: 'networkidle0' });
  await page.waitForFunction(
    () => !!(window as any).arrangementStore && !!(window as any).__engineBridge,
    { timeout: 20_000 },
  );
  await page.waitForFunction(
    () => ((window as any).__engineBridge?.discoveredEffects?.() ?? []).includes('source.video.file'),
    { timeout: 30_000 },
  );

  // Solid + adjustment + a REAL video clip active over the exported range.
  await page.evaluate(() => {
    const store = (window as any).arrangementStore;
    while (store.composition.tracks.filter((t: any) => t.kind === 'track').length < 3) store.addTrack();
    const tracks = store.composition.tracks.filter((t: any) => t.kind === 'track');
    const mkFx = (trackId: string, type: string) => {
      const path = store.createEmptyClip(trackId, 0, 4);
      const [, tId, cId] = path.split('/');
      store.addClipDeviceType(tId, cId, type);
    };
    mkFx(tracks[0].id, 'source.solid_color');
    store.addVideoClip(tracks[1].id, 0, {
      sourceKey: 'export-e2e', url: '/media/test_h264.mp4',
      frameCount: 55, fps: 30, width: 1280, height: 720, label: 'h264',
    }, 4);
    mkFx(tracks[2].id, 'color.invert');
    store.setPosition(1);
  });
  await new Promise((r) => setTimeout(r, 1500)); // let the live engine settle

  const res = await page.evaluate(async () => {
    // eval-wrapped so jest's babel transform can't rewrite the dynamic import.
    const mod = await (0, eval)('import("/src/views/arrangement/engine/export-renderer.ts")');
    if (!mod.canExport()) return { unsupported: true } as any;
    const r = await mod.exportComposition({
      width: 160, height: 90, fps: 12,
      startBeat: 0, endBeat: 2,
      bitrate: 500_000,
      ignoreSolo: false,
    });
    return { frames: r.frames, engineFrames: r.engineFrames, blobSize: r.blob ? r.blob.size : 0, durationSec: r.durationSec };
  });

  if ((res as any).unsupported) throw new Error('WebCodecs export unsupported in this browser build');
  expect(errors).toEqual([]);
  return res;
}

describe('Arrangement offline export (GPU, real media)', () => {
  jest.setTimeout(180_000);

  it('exports an MP4 (second comp-executor worker beside the live one)', async () => {
    const r = await runExport(URL);
    // 2 beats @120BPM = 1s @12fps ⇒ 12-13 frames.
    expect(r.frames).toBeGreaterThanOrEqual(10);
    // Clips cover the whole range → every frame must come from the comp
    // executor, none from the backdrop fallback (catches a silent
    // discovery/schema failure that would export pure background).
    expect(r.engineFrames).toBe(r.frames);
    expect(r.blobSize).toBeGreaterThan(1000);
  });
});
