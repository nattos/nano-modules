/**
 * WorkspaceBackend — the storage seam for Nano Arrangement.
 *
 * Arrangements are *files on disk*: one JSON file per arrangement
 * (`<name>.nano-arr`, a serialized `Composition`) in a user-mounted workspace
 * directory. The persistence pivot away from IndexedDB-stored documents.
 *
 * The File System Access picker, the Origin-Private File System (OPFS) and
 * Electron's fs-backed handles all satisfy `PathsDirectoryHandle`
 * (`state/paths.ts`), so a single `DirectoryBackend` serves all three — the
 * factories differ only in how they obtain the handle and whether a permission
 * grant is required:
 *   - `mountViaPicker()`  — the shared picker (native dialog under Electron, FSA on the web)
 *   - `mountOpfs()`       — `navigator.storage.getDirectory()` (headless tests; no prompt)
 *
 * The picked directory handle is persisted via `workspace-store.ts` so the same
 * folder re-mounts across reloads after a permission re-grant.
 */

import { toJS } from 'mobx';
import {
  showDirectoryPicker,
  type PathsDirectoryHandle,
  type PathsFileHandle,
} from '../../../state/paths';
import { ENGINE_VERSION } from '../../../version';
import type { Clip, Composition, Track } from '../model/composition';
import { emptyComposition } from '../model/composition';

/** File extension for a serialized arrangement. */
export const ARRANGEMENT_EXT = '.nano-arr';

/** One arrangement file in the workspace. */
export interface WorkspaceEntry {
  /**
   * Relative path identity WITHOUT the extension, e.g. "intro" or
   * "scenes/intro". This is what `read`/`write`/`remove` take.
   */
  name: string;
  /** On-disk base file name, e.g. "intro.nano-arr". */
  fileName: string;
  /** Relative directory (POSIX-joined), "" for the workspace root. */
  dir: string;
  /** Last-modified time (epoch ms), for a "… ago" tag. 0 if unknown. */
  modified: number;
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
  /** Rename/move one arrangement (content preserved). Throws if `to` exists. */
  rename(from: string, to: string): Promise<void>;
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

/**
 * SHAPE-only normalization of sequence clips (id uniqueness and the one-level
 * rule are `store.repairIds`' job, on the same load path). A clip whose `kind`
 * and `sequence` disagree would make every `isSequenceClip()` reader disagree
 * with the payload, so reconcile them here; and fill the interior lane's
 * required Track fields so the surfaces can't hit an undefined `clips`.
 */
function normalizeSequenceLanes(tracks: Track[]): Track[] {
  const fixLane = (lane: Partial<Track> | undefined): Track | undefined => {
    if (!lane || typeof lane !== 'object') return undefined;
    const out: Track = {
      id: typeof lane.id === 'string' ? lane.id : '', // '' ⇒ repairIds mints one
      name: lane.name ?? 'Sequence',
      kind: lane.kind === 'scene' ? 'scene' : 'track',
      parentId: null,
      sketch: lane.sketch ?? { devices: [] },
      automation: lane.automation ?? [],
      clips: Array.isArray(lane.clips) ? lane.clips : [],
      ...(lane.transport ? { transport: lane.transport } : {}),
      ...(lane.triggerRead ? { triggerRead: lane.triggerRead } : {}),
      ...(lane.level !== undefined ? { level: lane.level } : {}),
      ...(lane.blendMode !== undefined ? { blendMode: lane.blendMode } : {}),
    };
    for (const c of out.clips) fixClip(c);
    return out;
  };
  const fixClip = (clip: Clip): void => {
    const lane = fixLane(clip.sequence);
    if (lane) {
      clip.sequence = lane;
      clip.kind = 'sequence';
    } else {
      delete clip.sequence;
      if (clip.kind === 'sequence') clip.kind = 'effect';
    }
  };
  for (const t of tracks) for (const c of t.clips ?? []) fixClip(c);
  return tracks;
}

/**
 * Parse an arrangement file. Tolerates a bare `Composition` (no envelope) and
 * normalizes against `emptyComposition()` defaults so a partial / old / corrupt
 * file can never white-screen the surfaces (which assume `tracks`/`rails` etc.).
 */
export function deserializeComposition(text: string): Composition {
  const parsed = JSON.parse(text);
  const comp = (parsed && parsed.format === 'nano-arr' && parsed.composition
    ? parsed.composition
    : parsed) as Partial<Composition> | null;
  const base = emptyComposition();
  return {
    meta: { ...base.meta, ...(comp?.meta ?? {}) },
    tracks: normalizeSequenceLanes(comp?.tracks ?? base.tracks),
    rails: comp?.rails ?? base.rails,
    playMode: { ...base.playMode, ...(comp?.playMode ?? {}) },
    loop: comp?.loop, // persisted loop markers (undefined on legacy files ⇒ store keeps defaults)
  };
}

/**
 * A `WorkspaceBackend` over any directory handle (see `state/paths.ts`). Used identically
 * for a user-picked folder and an OPFS directory.
 */
export class DirectoryBackend implements WorkspaceBackend {
  constructor(
    public readonly dir: PathsDirectoryHandle,
    public readonly label: string,
  ) {}

  async list(): Promise<WorkspaceEntry[]> {
    const out: WorkspaceEntry[] = [];
    // Recurse subfolders so the Workspace tab can group files by directory.
    const walk = async (dir: PathsDirectoryHandle, prefix: string): Promise<void> => {
      // `values()` is an async iterator over the directory's child handles.
      for await (const handle of dir.values()) {
        if (handle.kind === 'file' && handle.name.endsWith(ARRANGEMENT_EXT)) {
          const base = handle.name.slice(0, -ARRANGEMENT_EXT.length);
          let modified = 0;
          try { modified = (await (handle as PathsFileHandle).getFile()).lastModified; } catch { /* keep 0 */ }
          out.push({
            name: prefix ? `${prefix}/${base}` : base,
            fileName: handle.name,
            dir: prefix,
            modified,
          });
        } else if (handle.kind === 'directory' && !handle.name.startsWith('.')) {
          await walk(handle as PathsDirectoryHandle, prefix ? `${prefix}/${handle.name}` : handle.name);
        }
      }
    };
    await walk(this.dir, '');
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  async read(name: string): Promise<Composition> {
    const fh = await this.fileHandle(name);
    const file = await fh.getFile();
    return deserializeComposition(await file.text());
  }

  async write(name: string, comp: Composition): Promise<void> {
    const fh = await this.fileHandle(name, true);
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

  async rename(from: string, to: string): Promise<void> {
    if (from === to) return;
    if (await this.exists(to)) {
      throw new Error(`Arrangement "${to}" already exists`);
    }
    // No native move in the FS Access API — read, re-write, delete the original.
    await this.write(to, await this.read(from));
    await this.remove(from);
  }

  async remove(name: string): Promise<void> {
    const parts = fileNameFor(name).split('/').filter(Boolean);
    let dir = this.dir;
    for (let i = 0; i < parts.length - 1; i++) {
      dir = await dir.getDirectoryHandle(parts[i]);
    }
    await dir.removeEntry(parts[parts.length - 1]);
  }

  /** Walk a `/`-separated relative path to its file handle. */
  private async fileHandle(name: string, create = false): Promise<PathsFileHandle> {
    const parts = fileNameFor(name).split('/').filter(Boolean);
    let dir = this.dir;
    for (let i = 0; i < parts.length - 1; i++) {
      dir = await dir.getDirectoryHandle(parts[i], { create });
    }
    return dir.getFileHandle(parts[parts.length - 1], { create });
  }

  private async exists(name: string): Promise<boolean> {
    try {
      await this.fileHandle(name);
      return true;
    } catch {
      return false;
    }
  }
}

/** Mount a workspace by prompting the user to pick a folder. Needs a gesture.
 *  Routes through the shared picker, so Electron gets the native dialog (and an
 *  fs-backed handle) with no branch here. */
export async function mountViaPicker(): Promise<DirectoryBackend> {
  const dir = await showDirectoryPicker();
  if (!dir) throw new Error('No folder selected');
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
