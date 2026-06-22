/**
 * WorkspaceBackend — the storage seam for Nano Arrangement.
 *
 * Arrangements are *files on disk*: one JSON file per arrangement
 * (`<name>.nano-arr`, a serialized `Composition`) in a user-mounted workspace
 * directory. The persistence pivot away from IndexedDB-stored documents.
 *
 * Both the File System Access picker and the Origin-Private File System (OPFS)
 * hand back a `FileSystemDirectoryHandle`, so a single `DirectoryBackend`
 * serves both — the factories differ only in how they obtain the handle and
 * whether a permission grant is required:
 *   - `mountViaPicker()`  — real `showDirectoryPicker()` (users; needs permission)
 *   - `mountOpfs()`       — `navigator.storage.getDirectory()` (headless tests; no prompt)
 *
 * The picked directory handle is persisted via `workspace-store.ts` so the same
 * folder re-mounts across reloads after a permission re-grant.
 */

import { toJS } from 'mobx';
import { ENGINE_VERSION } from '../../../version';
import type { Composition } from '../model/composition';
import { emptyComposition } from '../model/composition';

/** File extension for a serialized arrangement. */
export const ARRANGEMENT_EXT = '.nano-arr';

/** One arrangement file in the workspace. */
export interface WorkspaceEntry {
  /** Arrangement name (file name without the extension). */
  name: string;
  /** On-disk file name, e.g. "intro.nano-arr". */
  fileName: string;
}

/** On-disk envelope around a `Composition` — versioned for future migrations. */
export interface ArrangementFile {
  format: 'nano-arr';
  engineVersion: [number, number, number];
  composition: Composition;
}

/** The storage seam every arrangement read/write goes through. */
export interface WorkspaceBackend {
  /** Human-facing label of the mounted workspace (folder name / opfs tag). */
  readonly label: string;
  /** List the arrangement files in the workspace, sorted by name. */
  list(): Promise<WorkspaceEntry[]>;
  /** Read + deserialize one arrangement. Throws if it doesn't exist. */
  read(name: string): Promise<Composition>;
  /** Serialize + write one arrangement (creates or overwrites). */
  write(name: string, comp: Composition): Promise<void>;
  /** Create a new arrangement; throws if one with that name already exists. */
  create(name: string, comp?: Composition): Promise<void>;
  /** Delete one arrangement file. */
  remove(name: string): Promise<void>;
}

function fileNameFor(name: string): string {
  return name.endsWith(ARRANGEMENT_EXT) ? name : `${name}${ARRANGEMENT_EXT}`;
}

/**
 * Sanitize MobX proxies out (the serialization-boundary rule) and wrap the
 * composition in the versioned envelope. Mirrors `project-store.saveProject`.
 */
export function serializeComposition(comp: Composition): string {
  const safe = JSON.parse(JSON.stringify(toJS(comp))) as Composition;
  const file: ArrangementFile = {
    format: 'nano-arr',
    engineVersion: ENGINE_VERSION,
    composition: safe,
  };
  return JSON.stringify(file, null, 2);
}

/** Parse an arrangement file. Tolerates a bare `Composition` (no envelope). */
export function deserializeComposition(text: string): Composition {
  const parsed = JSON.parse(text);
  if (parsed && parsed.format === 'nano-arr' && parsed.composition) {
    return parsed.composition as Composition;
  }
  return parsed as Composition;
}

/**
 * A `WorkspaceBackend` over any `FileSystemDirectoryHandle`. Used identically
 * for a user-picked folder and an OPFS directory.
 */
export class DirectoryBackend implements WorkspaceBackend {
  constructor(
    public readonly dir: FileSystemDirectoryHandle,
    public readonly label: string,
  ) {}

  async list(): Promise<WorkspaceEntry[]> {
    const out: WorkspaceEntry[] = [];
    // `values()` is an async iterator over the directory's child handles.
    for await (const handle of (this.dir as any).values() as AsyncIterable<FileSystemHandle>) {
      if (handle.kind === 'file' && handle.name.endsWith(ARRANGEMENT_EXT)) {
        out.push({
          name: handle.name.slice(0, -ARRANGEMENT_EXT.length),
          fileName: handle.name,
        });
      }
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  async read(name: string): Promise<Composition> {
    const fh = await this.dir.getFileHandle(fileNameFor(name));
    const file = await fh.getFile();
    return deserializeComposition(await file.text());
  }

  async write(name: string, comp: Composition): Promise<void> {
    const fh = await this.dir.getFileHandle(fileNameFor(name), { create: true });
    const writable = await fh.createWritable();
    await writable.write(serializeComposition(comp));
    await writable.close();
  }

  async create(name: string, comp?: Composition): Promise<void> {
    if (await this.exists(name)) {
      throw new Error(`Arrangement "${name}" already exists`);
    }
    await this.write(name, comp ?? emptyComposition());
  }

  async remove(name: string): Promise<void> {
    await this.dir.removeEntry(fileNameFor(name));
  }

  private async exists(name: string): Promise<boolean> {
    try {
      await this.dir.getFileHandle(fileNameFor(name));
      return true;
    } catch {
      return false;
    }
  }
}

/** Mount a workspace by prompting the user to pick a folder. Needs a gesture. */
export async function mountViaPicker(): Promise<DirectoryBackend> {
  const picker = (window as any).showDirectoryPicker;
  if (typeof picker !== 'function') {
    throw new Error('File System Access API (showDirectoryPicker) is unavailable');
  }
  const dir: FileSystemDirectoryHandle = await picker({ mode: 'readwrite' });
  return new DirectoryBackend(dir, dir.name || 'workspace');
}

/**
 * Mount an OPFS-backed workspace (no permission prompt). Used by component test
 * pages so Puppeteer can exercise the full mount/read/write path headlessly.
 */
export async function mountOpfs(subdir = 'arrangement-workspace'): Promise<DirectoryBackend> {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(subdir, { create: true });
  return new DirectoryBackend(dir, `opfs:${subdir}`);
}
