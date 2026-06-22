/**
 * Workspace testbed boot — Component A manual + e2e harness.
 *
 * Manual: mount a real folder (picker) or OPFS, then create / save / delete
 * `*.nano-arr` files and inspect the serialized JSON.
 *
 * E2e: Puppeteer drives `window.__workspace` against the OPFS backend (the
 * native directory picker can't be scripted headlessly).
 */

import {
  mountViaPicker,
  mountOpfs,
  type WorkspaceBackend,
  type WorkspaceEntry,
} from './views/arrangement/workspace/backend';
import { rememberWorkspace, restoreWorkspace } from './views/arrangement/workspace/workspace-store';
import { emptyComposition, type Composition } from './views/arrangement/model/composition';

let backend: WorkspaceBackend | null = null;
let current: string | null = null;

const $ = (id: string) => document.getElementById(id)!;
const setStatus = (s: string) => { $('status').textContent = s; };
const setLabel = (s: string) => { $('label').textContent = s; };

async function refreshList(): Promise<WorkspaceEntry[]> {
  const files = backend ? await backend.list() : [];
  const host = $('files');
  host.innerHTML = '';
  for (const e of files) {
    const b = document.createElement('button');
    b.textContent = e.name;
    if (e.name === current) b.className = 'active';
    b.onclick = () => openArrangement(e.name);
    host.appendChild(b);
  }
  return files;
}

async function openArrangement(name: string): Promise<void> {
  if (!backend) return;
  current = name;
  const comp = await backend.read(name);
  ($('json') as HTMLTextAreaElement).value = JSON.stringify(comp, null, 2);
  setStatus(`Opened "${name}".`);
  await refreshList();
}

async function adopt(b: WorkspaceBackend): Promise<void> {
  backend = b;
  setLabel(`(${b.label})`);
  setStatus(`Mounted ${b.label}.`);
  await refreshList();
}

$('pick').addEventListener('click', async () => {
  try {
    const b = await mountViaPicker();
    await rememberWorkspace(b.dir, b.label);
    await adopt(b);
  } catch (err) {
    setStatus(`Picker cancelled / unavailable: ${err}`);
  }
});

$('opfs').addEventListener('click', async () => {
  await adopt(await mountOpfs());
});

$('restore').addEventListener('click', async () => {
  const b = await restoreWorkspace();
  if (b) await adopt(b);
  else setStatus('No remembered workspace (or permission declined).');
});

$('create').addEventListener('click', async () => {
  if (!backend) return setStatus('Mount a workspace first.');
  const name = ($('name') as HTMLInputElement).value.trim();
  if (!name) return setStatus('Enter a name.');
  try {
    await backend.create(name, emptyComposition());
    await openArrangement(name);
  } catch (err) {
    setStatus(String(err));
  }
});

$('save').addEventListener('click', async () => {
  if (!backend || !current) return setStatus('Open an arrangement first.');
  try {
    const comp = JSON.parse(($('json') as HTMLTextAreaElement).value) as Composition;
    await backend.write(current, comp);
    setStatus(`Saved "${current}".`);
  } catch (err) {
    setStatus(`Save failed: ${err}`);
  }
});

$('delete').addEventListener('click', async () => {
  if (!backend || !current) return setStatus('Open an arrangement first.');
  await backend.remove(current);
  setStatus(`Deleted "${current}".`);
  current = null;
  ($('json') as HTMLTextAreaElement).value = '';
  await refreshList();
});

$('reload').addEventListener('click', () => void refreshList());

// E2e hook — Puppeteer drives the OPFS backend through these imperative calls.
(window as any).__workspace = {
  async useOpfs(subdir?: string) {
    await adopt(await mountOpfs(subdir));
    return backend!.label;
  },
  async usePicker() {
    const b = await mountViaPicker();
    await rememberWorkspace(b.dir, b.label);
    await adopt(b);
    return b.label;
  },
  get backend() { return backend; },
  list: () => backend!.list(),
  read: (n: string) => backend!.read(n),
  write: (n: string, c: Composition) => backend!.write(n, c),
  create: (n: string, c?: Composition) => backend!.create(n, c),
  remove: (n: string) => backend!.remove(n),
  emptyComposition,
};
