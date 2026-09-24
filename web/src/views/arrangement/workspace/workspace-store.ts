/**
 * Persist + restore the active workspace directory.
 *
 * The workspace folder is stored as a `HandleRef` (see `handle-ref.ts`): if it
 * lives under a library path it's kept RELATIVE to that library, so granting the
 * library once re-mounts the workspace without a separate prompt; otherwise it
 * falls back to a direct handle.
 *
 * The desktop app keeps the plain absolute path instead, as the `workspace`
 * section of `Settings/arrangement.json` (settings-files.ts) — no permission
 * to re-grant, and an external edit re-mounts live (`watchWorkspace`).
 */

import { idbGet, idbPut, idbDelete, STORE_WORKSPACE } from '../../../state/idb-store';
import { DirectoryBackend } from './backend';
import { HandleRef, makeHandleRef, resolveDirRef } from '../../../state/handle-ref';
import { absPathOf, getHandleFromAbsPath, type PathsDirectoryHandle } from '../../../state/paths';
import {
  readSection, settingsFilesAvailable, SETTINGS_FILES, watchSection, writeSection,
} from '../../../state/settings-files';

const FILE = SETTINGS_FILES.arrangement;
const SECTION = 'workspace';

/** The desktop record: where the folder is, and what to call it. */
export interface WorkspaceSection { path: string; label: string }

function validSection(v: WorkspaceSection | null | undefined): WorkspaceSection | null {
  return v && typeof v.path === 'string' && v.path ? v : null;
}

function fileSection(): WorkspaceSection | null {
  return validSection(readSection<WorkspaceSection>(FILE, SECTION));
}

/** Open a recorded folder, or null when it's gone. */
export async function backendForSection(sec: WorkspaceSection): Promise<DirectoryBackend | null> {
  const dir = await getHandleFromAbsPath(sec.path);
  if (!dir || dir.kind !== 'directory') return null;
  return new DirectoryBackend(dir as PathsDirectoryHandle, sec.label || (dir as PathsDirectoryHandle).name);
}

async function restoreFromFile(): Promise<DirectoryBackend | null> {
  const sec = fileSection();
  return sec ? backendForSection(sec) : null;
}

const CURRENT_KEY = 'current';

interface WorkspaceHandleRecord {
  id: string; // 'current'
  /** Library-relative or direct reference to the workspace directory. */
  ref: HandleRef;
  label: string;
  mountedAt: number;
}

/** Remember a workspace so it can be re-mounted after reload. */
export async function rememberWorkspace(dir: PathsDirectoryHandle, label: string): Promise<void> {
  const abs = absPathOf(dir);
  if (settingsFilesAvailable() && abs) {
    writeSection(FILE, SECTION, { path: abs, label } satisfies WorkspaceSection);
    return;
  }
  const ref = await makeHandleRef(dir);
  const rec: WorkspaceHandleRecord = { id: CURRENT_KEY, ref, label, mountedAt: Date.now() };
  await idbPut(STORE_WORKSPACE, rec);
}

/** Forget the active workspace (e.g. user unmounts). */
export async function forgetWorkspace(): Promise<void> {
  if (settingsFilesAvailable()) { writeSection(FILE, SECTION, undefined); return; }
  await idbDelete(STORE_WORKSPACE, CURRENT_KEY);
}

/**
 * Re-mount the remembered workspace, prompting for permission if needed (call
 * from a user gesture). Returns null if none is remembered or it can't resolve.
 */
export async function restoreWorkspace(): Promise<DirectoryBackend | null> {
  if (settingsFilesAvailable()) return restoreFromFile();
  const rec = await idbGet<WorkspaceHandleRecord>(STORE_WORKSPACE, CURRENT_KEY);
  if (!rec) return null;
  const dir = await resolveDirRef(rec.ref, { prompt: true });
  return dir ? new DirectoryBackend(dir, rec.label) : null;
}

/** Re-mount silently — query-only, no prompt (safe on boot). */
export async function restoreWorkspaceSilent(): Promise<DirectoryBackend | null> {
  if (settingsFilesAvailable()) return restoreFromFile();
  const rec = await idbGet<WorkspaceHandleRecord>(STORE_WORKSPACE, CURRENT_KEY);
  if (!rec) return null;
  const dir = await resolveDirRef(rec.ref, { prompt: false });
  return dir ? new DirectoryBackend(dir, rec.label) : null;
}

/** Peek at the remembered workspace's label without touching permission. */
export async function rememberedWorkspaceLabel(): Promise<string | null> {
  if (settingsFilesAvailable()) return fileSection()?.label ?? null;
  const rec = await idbGet<WorkspaceHandleRecord>(STORE_WORKSPACE, CURRENT_KEY);
  return rec?.label ?? null;
}

/** Desktop only: `cb` whenever the file's `workspace` section is edited from
 *  outside (null = cleared). A no-op in the browser. */
export function watchWorkspace(cb: (sec: WorkspaceSection | null) => void): () => void {
  return watchSection<WorkspaceSection>(FILE, SECTION, (v) => cb(validSection(v)));
}
