#!/usr/bin/env python3
"""abi_coverage.py — does any effect bundle call a host import that no bundle
built from THIS repo calls?

Our tests run on the bundles this repo builds — testonly.wasm and the shipped
core/text/richtext — never on modules that live in other repositories (the
extras: nano, lights, legacy, or anyone's own). So an import only a module
bundle reaches is a host ABI path we ship without a test: add a test-only
effect that calls it (see debug.raster_test / compute_probe / trigger_probe).

  native/tools/abi_coverage.py                     # every other *.wasm in build/wasm
  native/tools/abi_coverage.py path/to/a.wasm ...  # specific bundles
  native/tools/abi_coverage.py --testonly          # stricter: only testonly counts

Exit status 1 when any bundle has an uncovered import.

Service modules (executor, bridge_core, naga_spv, text_engine, text_blitz,
dxv_decoder) are skipped: they are not effects and speak other interfaces.
"""

import glob
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
WASM_DIR = os.path.normpath(os.path.join(HERE, '..', '..', 'build', 'wasm'))
SERVICES = {'executor', 'bridge_core', 'naga_spv', 'text_engine', 'text_blitz',
            'dxv_decoder'}
# Built here, and exercised by this repo's own tests.
IN_REPO = ['testonly', 'core', 'text', 'richtext']


def _leb(b, i):
  r = s = 0
  while True:
    x = b[i]
    i += 1
    r |= (x & 0x7f) << s
    s += 7
    if x < 0x80:
      return r, i


def imports(path):
  """The set of 'module.name' function/global/table/memory imports."""
  b = open(path, 'rb').read()
  if b[:4] != b'\0asm':
    raise ValueError(f'{path}: not a wasm module')
  i, out = 8, set()
  while i < len(b):
    sid = b[i]
    i += 1
    size, i = _leb(b, i)
    end = i + size
    if sid == 2:
      n, i = _leb(b, i)
      for _ in range(n):
        ln, i = _leb(b, i)
        mod = b[i:i + ln].decode()
        i += ln
        ln, i = _leb(b, i)
        name = b[i:i + ln].decode()
        i += ln
        kind = b[i]
        i += 1
        if kind == 0:                     # func: type index
          _, i = _leb(b, i)
        elif kind == 1:                   # table: reftype + limits
          i += 1
          flags, i = _leb(b, i)
          _, i = _leb(b, i)
          if flags & 1:
            _, i = _leb(b, i)
        elif kind == 2:                   # memory: limits
          flags, i = _leb(b, i)
          _, i = _leb(b, i)
          if flags & 1:
            _, i = _leb(b, i)
        elif kind == 3:                   # global: valtype + mutability
          i += 2
        out.add(f'{mod}.{name}')
      return out
    i = end
  return out


def main(argv):
  strict = '--testonly' in argv
  argv = [a for a in argv if a != '--testonly']
  baseline = ['testonly'] if strict else IN_REPO
  covered = set()
  for stem in baseline:
    path = os.path.join(WASM_DIR, stem + '.wasm')
    if not os.path.exists(path):
      print(f'error: {path} missing — run native/wasm_modules/build_all.sh',
            file=sys.stderr)
      return 2
    covered |= imports(path)
  paths = argv or sorted(glob.glob(os.path.join(WASM_DIR, '*.wasm')))
  gaps = 0
  for p in paths:
    stem = os.path.splitext(os.path.basename(p))[0]
    if not argv and (stem in SERVICES or stem in baseline):
      continue
    missing = sorted(imports(p) - covered)
    if missing:
      gaps += len(missing)
      print(f'{stem}: {len(missing)} import(s) no {"/".join(baseline)} bundle calls')
      for m in missing:
        print(f'  {m}')
    else:
      print(f'{stem}: covered')
  return 1 if gaps else 0


if __name__ == '__main__':
  sys.exit(main(sys.argv[1:]))
