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
      store.showRightTab('workspace');

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
      const files = Array.from(insp?.querySelectorAll('.ws-file .ws-name') ?? []).map((e) => (e as any).value);
      const active = (insp?.querySelector('.ws-file.active .ws-name') as any)?.value;
      return { dirHeads, files, active };
    });
    expect(dom.dirHeads).toContain('scenes/');
    expect(dom.files).toEqual(expect.arrayContaining(['intro', 'verse']));
    expect(dom.active).toBe('verse');
  }, 30000);

  it('refreshes the panel reactively on mount, and renames + deletes files', async () => {
    // Switch to the (empty) Files tab FIRST, then mount — the panel must update
    // without any further tab switch (the mobx-reactivity regression).
    await page.evaluate(async () => {
      const store = (window as any).arrangementStore;
      const mod = (window as any).__workspaceBackend;
      store.showRightTab('workspace');
      const be = await mod.mountOpfs('react-' + Math.floor(performance.now()));
      await be.write('alpha', mod.deserializeComposition('{}'));
      await be.write('beta', mod.deserializeComposition('{}'));
      await store.mountWorkspace(be);
    });
    // Files appear with NO extra showRightTab call → reactivity works.
    await page.waitForFunction(() => {
      const insp = document.querySelector('arrangement-app')?.shadowRoot
        ?.querySelector('arr-inspector')?.shadowRoot;
      return (insp?.querySelectorAll('.ws-file').length ?? 0) >= 2;
    }, { timeout: 5000 });

    // Each row has an editable name + a "… ago" tag.
    const row = await page.evaluate(() => {
      const insp = document.querySelector('arrangement-app')?.shadowRoot
        ?.querySelector('arr-inspector')?.shadowRoot;
      const first = insp?.querySelector('.ws-file');
      return {
        hasEditable: !!first?.querySelector('editable-label'),
        hasAgo: !!first?.querySelector('.ws-ago'),
        ago: first?.querySelector('.ws-ago')?.textContent?.trim(),
      };
    });
    expect(row.hasEditable).toBe(true);
    expect(row.hasAgo).toBe(true);
    expect(row.ago).toBeTruthy();

    // Rename alpha → gamma via the store action the editable-label commit calls.
    const renamed = await page.evaluate(async () => {
      const store = (window as any).arrangementStore;
      await store.openEntry('alpha');
      await store.renameEntry('alpha', 'gamma');
      return { names: store.workspaceEntries.map((e: any) => e.name).sort(), current: store.currentName };
    });
    expect(renamed.names).toEqual(['beta', 'gamma']);
    expect(renamed.current).toBe('gamma'); // open file followed the rename

    // Delete the open file → falls back to the remaining one.
    const deleted = await page.evaluate(async () => {
      const store = (window as any).arrangementStore;
      await store.deleteEntry('gamma');
      return { names: store.workspaceEntries.map((e: any) => e.name), current: store.currentName };
    });
    expect(deleted.names).toEqual(['beta']);
    expect(deleted.current).toBe('beta');
  }, 30000);

  it('auto-restores the remembered workspace on reload', async () => {
    // Mount a fresh OPFS workspace (this remembers the handle in IDB). OPFS
    // handles report permission granted, exercising the silent re-mount path.
    const tag = await page.evaluate(async () => {
      const store = (window as any).arrangementStore;
      const mod = (window as any).__workspaceBackend;
      const t = 'auto-' + Math.floor(performance.now());
      const be = await mod.mountOpfs(t);
      await be.write('remembered', mod.deserializeComposition('{}'));
      await store.mountWorkspace(be);
      return t;
    });

    // Reload — nothing is mounted at module init; auto-restore runs on boot.
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForFunction(() => !!(window as any).arrangementStore, { timeout: 10000 });
    await page.waitForFunction(() => (window as any).arrangementStore.hasWorkspace, { timeout: 10000 });

    const after = await page.evaluate(() => {
      const store = (window as any).arrangementStore;
      return { label: store.workspaceLabel, current: store.currentName, count: store.workspaceEntries.length };
    });
    expect(after.label).toBe(`opfs:${tag}`);
    expect(after.current).toBe('remembered');
    expect(after.count).toBe(1);
  }, 30000);
});
