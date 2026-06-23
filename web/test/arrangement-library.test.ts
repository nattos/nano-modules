/**
 * Library paths + HandleRef e2e, driven over OPFS (which implements the real
 * resolve()/getDirectoryHandle()/isSameEntry() the FS Access picker would, but
 * scriptable headlessly). Covers: library-relative ref creation & resolution,
 * media-store round-trip, and a workspace that lives UNDER a library path being
 * re-mounted relative to it after a reload.
 */
import puppeteer, { Browser, Page } from 'puppeteer';

const BASE_URL = process.env.ARR_BASE_URL || process.env.GPU_TEST_BASE_URL || 'http://localhost:5174';

describe('Library paths + HandleRef', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    page = await browser.newPage();
    await page.goto(`${BASE_URL}/arrangement.html`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(
      () => !!(window as any).__libraryPaths && !!(window as any).__handleRef && !!(window as any).__mediaStore,
      { timeout: 10000 },
    );
  });

  afterAll(async () => { await browser?.close(); });

  it('makes/resolves library-relative refs and round-trips media', async () => {
    const r = await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const lib = await root.getDirectoryHandle('lib-' + Math.floor(performance.now()), { create: true });
      const media = await lib.getDirectoryHandle('media', { create: true });
      const fh = await media.getFileHandle('clip.bin', { create: true });
      const w = await fh.createWritable(); await w.write('hello-media'); await w.close();

      await (window as any).__libraryPaths.add(lib, 'My Lib');
      const ref = await (window as any).__handleRef.makeHandleRef(fh);
      const back = await (window as any).__handleRef.resolveFileRef(ref);
      const text = back ? await (await back.getFile()).text() : null;

      // media-store round-trip
      const key = await (window as any).__mediaStore.linkMedia(fh);
      const rec = await (window as any).__mediaStore.resolveMedia(key);
      const file = await (window as any).__mediaStore.openMedia(key);
      return {
        refKind: ref.kind, refPath: ref.path,
        text,
        mediaRefKind: rec?.ref?.kind,
        fileText: file ? await file.text() : null,
      };
    });
    expect(r.refKind).toBe('lib');
    expect(r.refPath).toEqual(['media', 'clip.bin']);
    expect(r.text).toBe('hello-media');
    expect(r.mediaRefKind).toBe('lib');
    expect(r.fileText).toBe('hello-media');
  }, 30000);

  it('falls back to a direct ref outside any library', async () => {
    const kind = await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      // A dir NOT registered as a library.
      const outside = await root.getDirectoryHandle('outside-' + Math.floor(performance.now()), { create: true });
      const fh = await outside.getFileHandle('lone.bin', { create: true });
      const ref = await (window as any).__handleRef.makeHandleRef(fh);
      return ref.kind;
    });
    expect(kind).toBe('direct');
  }, 30000);

  it('adds a library path from a folder dropped on the Settings drop zone', async () => {
    const added = await page.evaluate(async () => {
      const store = (window as any).arrangementStore;
      store.setRightTab('settings');
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const insp: any = document.querySelector('arrangement-app')!.shadowRoot!
        .querySelector('arr-inspector');
      const before = (window as any).__libraryPaths.paths.length;

      const root = await navigator.storage.getDirectory();
      const dropped = await root.getDirectoryHandle('dropped-lib', { create: true });
      // Mirror a real folder drop: a DataTransfer whose item yields a dir handle.
      const fakeEvent = {
        dataTransfer: { items: [{ kind: 'file', getAsFileSystemHandle: async () => dropped }] },
        preventDefault() {}, stopPropagation() {},
      };
      await insp.onLibraryDrop(fakeEvent);
      const paths = (window as any).__libraryPaths.paths;
      return { before, after: paths.length, hasDropped: paths.some((p: any) => p.label === 'dropped-lib') };
    });
    expect(added.after).toBeGreaterThanOrEqual(added.before + 1);
    expect(added.hasDropped).toBe(true);

    // The Settings tab shows the dropped library row.
    const labels = await page.evaluate(() => {
      const insp = document.querySelector('arrangement-app')!.shadowRoot!
        .querySelector('arr-inspector')!.shadowRoot!;
      return Array.from(insp.querySelectorAll('.lib-drop .ws-file .ws-name')).map((e) => e.textContent?.trim());
    });
    expect(labels).toContain('dropped-lib');
  }, 30000);

  it('re-mounts a workspace stored relative to a library after reload', async () => {
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const lib = await root.getDirectoryHandle('wslib', { create: true });
      const proj = await lib.getDirectoryHandle('proj', { create: true });
      const fh = await proj.getFileHandle('main.nano-arr', { create: true });
      const w = await fh.createWritable(); await w.write('{}'); await w.close();
      await (window as any).__libraryPaths.add(lib, 'WS Lib');
      const be = new ((window as any).__workspaceBackend.DirectoryBackend)(proj, 'proj');
      await (window as any).arrangementStore.mountWorkspace(be);
    });

    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForFunction(() => !!(window as any).arrangementStore, { timeout: 10000 });
    // Auto-mount on boot resolves the lib-relative workspace ref silently (OPFS
    // reports permission granted), so no gesture is needed here.
    await page.waitForFunction(() => (window as any).arrangementStore.hasWorkspace, { timeout: 10000 });

    const after = await page.evaluate(() => ({
      label: (window as any).arrangementStore.workspaceLabel,
      current: (window as any).arrangementStore.currentName,
    }));
    expect(after.label).toBe('proj');
    expect(after.current).toBe('main');
  }, 40000);
});
