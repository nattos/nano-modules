/**
 * electron/module-dirs.cjs — the JS half of native/src/bridge/module_dirs.h.
 * These cases mirror native/tests/test_module_dirs.cpp one for one: the barrel
 * and the app must resolve the same bundle set from the same directories.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const md = createRequire(import.meta.url)('../electron/module-dirs.cjs');

let root: string;
const dir = (name: string, files: string[]) => {
  const d = join(root, name);
  mkdirSync(d, { recursive: true });
  for (const f of files) writeFileSync(join(d, f), '');
  return d;
};
const stems = (bs: any[]) => bs.map((b) => b.stem);
const by = (bs: any[], stem: string) => bs.find((b) => b.stem === stem);

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'nano-moddirs-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('module-dirs', () => {
  it('takes only the known shipping stems from the built-in directory', () => {
    const builtin = dir('builtin', ['core.wasm', 'text.wasm', 'executor.wasm', 'naga_spv.wasm',
      'testonly.wasm', 'core-aarch64.aot']);
    const got = md.resolveBundles(builtin, []);
    expect(stems(got)).toEqual(['core', 'text']);
    expect(got[0]).toMatchObject({ id: 'com.nano.core', url: '/wasm/core.wasm', origin: 'builtin' });
  });

  it('lets the default directory fill in only what the app lacks', () => {
    const builtin = dir('builtin', ['core.wasm', 'nano.wasm']);
    const defaults = dir('default', ['nano.wasm', 'lights.wasm', 'readme.txt']);
    const got = md.resolveBundles(builtin, [defaults]);
    expect(stems(got)).toEqual(['core', 'nano', 'lights']);
    expect(by(got, 'nano').origin).toBe('builtin');
    expect(by(got, 'lights')).toMatchObject({ origin: 'default', url: '/modules/0/lights.wasm' });
  });

  it('lets a mapped directory replace by stem, the later mapping winning', () => {
    const builtin = dir('builtin', ['core.wasm']);
    const defaults = dir('default', ['lights.wasm']);
    const devA = dir('devA', ['core.wasm', 'mine.wasm']);
    const devB = dir('devB', ['mine.wasm']);
    const got = md.resolveBundles(builtin, [defaults, devA, devB]);
    expect(stems(got)).toEqual(['core', 'lights', 'mine']);
    expect(by(got, 'core')).toMatchObject({ origin: 'mapped', url: '/modules/1/core.wasm' });
    expect(by(got, 'mine').url).toBe('/modules/2/mine.wasm');
  });

  it('serves only .wasm files inside a configured directory', () => {
    const a = dir('a', ['x.wasm']);
    const dirs = [a];
    expect(md.resolveModuleUrl('/modules/0/x.wasm', dirs)).toBe(join(a, 'x.wasm'));
    expect(md.resolveModuleUrl('/modules/0/x.wasm?t=5', dirs)).toBe(join(a, 'x.wasm'));
    expect(md.resolveModuleUrl('/modules/1/x.wasm', dirs)).toBeNull();
    expect(md.resolveModuleUrl('/modules/0/secret.txt', dirs)).toBeNull();
    expect(md.resolveModuleUrl('/modules/0/..%2F..%2Fetc.wasm', dirs)).toBeNull();
    expect(md.urlForModuleFile(join(a, 'x.wasm'), dirs)).toBe('/modules/0/x.wasm');
    expect(md.urlForModuleFile(join(root, 'elsewhere.wasm'), dirs)).toBeNull();
  });

  it('round-trips module_paths.json, and junk reads as none mapped', () => {
    const file = join(root, 'cfg', 'module_paths.json');
    md.writeModulePaths([{ path: '/a', enabled: true }, { path: '/b', enabled: false }, { path: '' }], file);
    expect(md.readModulePaths(file)).toEqual([
      { path: '/a', enabled: true }, { path: '/b', enabled: false }]);
    writeFileSync(file, '{not json');
    expect(md.readModulePaths(file)).toEqual([]);
  });
});
