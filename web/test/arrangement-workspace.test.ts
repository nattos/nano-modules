/**
 * Workspace mount + Files tab e2e. Drives the OPFS backend (the real folder
 * picker can't be scripted headlessly) to verify the store mount/list/open
 * flow and that <arr-inspector>'s Workspace tab renders files grouped by dir.
 */
import puppeteer, { Browser, Page } from 'puppeteer';

const BASE_URL = process.env.ARR_BASE_URL || process.env.GPU_TEST_BASE_URL || 'http://localhost:5174';

describe('Arrangement workspace', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    page = await browser.newPage();
    await page.goto(`${BASE_URL}/arrangement.html`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => !!(window as any).arrangementStore && !!(window as any).__workspaceBackend, { timeout: 10000 });
  });

  afterAll(async () => {
    await browser?.close();
  });

  it('mounts an OPFS workspace, lists nested files grouped, and opens them', async () => {
    const result = await page.evaluate(async () => {
      const store = (window as any).arrangementStore;
      const mod = (window as any).__workspaceBackend;
      // Fresh, isolated OPFS subdir for this run.
      const tag = 'test-ws-' + Math.floor(performance.now());
      const backend = await mod.mountOpfs(tag);
      // Seed a root file and a nested-dir file BEFORE mounting.
      await backend.write('intro', mod.deserializeComposition('{}'));
      await backend.write('scenes/verse', mod.deserializeComposition('{}'));

      await store.mountWorkspace(backend);
      store.setRightTab('workspace');

      const names = store.workspaceEntries.map((e: any) => e.name).sort();
      const dirs = store.workspaceEntries.map((e: any) => e.dir).sort();
      // Switch to the nested file.
      await store.openEntry('scenes/verse');
      return {
        label: store.workspaceLabel,
        names,
        dirs,
        current: store.currentName,
        hasWorkspace: store.hasWorkspace,
      };
    });
    expect(result.hasWorkspace).toBe(true);
    expect(result.names).toEqual(['intro', 'scenes/verse']);
    expect(result.dirs).toContain('scenes');
    expect(result.current).toBe('scenes/verse');

    // The Files tab renders a directory heading + file rows.
    const dom = await page.evaluate(() => {
      const insp = document.querySelector('arrangement-app')?.shadowRoot
        ?.querySelector('arr-inspector')?.shadowRoot;
      const dirHeads = Array.from(insp?.querySelectorAll('.ws-dir') ?? []).map((e) => e.textContent?.trim());
      const files = Array.from(insp?.querySelectorAll('.ws-file') ?? []).map((e) => e.textContent?.trim());
      const active = insp?.querySelector('.ws-file.active')?.textContent?.trim();
      return { dirHeads, files, active };
    });
    expect(dom.dirHeads).toContain('scenes/');
    expect(dom.files).toEqual(expect.arrayContaining(['intro', 'verse']));
    expect(dom.active).toBe('verse');
  }, 30000);
});
