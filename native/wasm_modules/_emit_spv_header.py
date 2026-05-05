#!/usr/bin/env python3
"""
Emit a C++ header bundling one or more SPIR-V blobs as `static const
unsigned char` byte arrays. Replaces the old WGSL/MSL string emission
in wasm_build_env.sh — the runtime translates SPV → platform-native
shader source via the dev server's naga endpoint, so effects no
longer carry per-platform shader text.

Usage:
  _emit_spv_header.py <out_header> <var_name>=<spv_file> [<var_name>=<spv_file> ...]

Each <var_name>=<spv_file> pair becomes:

  static const unsigned char <VAR_NAME_UPPER>_SPV[] = { 0x03, 0x02, ... };
  static const int           <VAR_NAME_UPPER>_SPV_SIZE = <byte count>;

The emitted constants are referenced by the effect's main.cpp via
`state::registerShaderSPV("<lowercase variant>", <VAR>_SPV, <VAR>_SPV_SIZE)`.
"""

import sys
from pathlib import Path


def emit_array(name: str, data: bytes) -> str:
    out = [f'static const unsigned char {name}_SPV[] = {{']
    # 12 bytes per line keeps headers readable in a 100-col terminal.
    for i in range(0, len(data), 12):
        chunk = data[i:i + 12]
        line = '  ' + ', '.join(f'0x{b:02x}' for b in chunk) + ','
        out.append(line)
    out.append('};')
    out.append(f'static const int {name}_SPV_SIZE = {len(data)};')
    out.append('')
    return '\n'.join(out)


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__, file=sys.stderr)
        return 2
    out_path = Path(sys.argv[1])
    pairs = []
    for arg in sys.argv[2:]:
        if '=' not in arg:
            print(f'expected NAME=PATH, got {arg}', file=sys.stderr)
            return 2
        var, path = arg.split('=', 1)
        pairs.append((var.upper(), Path(path)))

    parts = ['/* Auto-generated SPIR-V shader header. Do not edit. */',
             '#pragma once', '']
    for var_name, spv_path in pairs:
        if not spv_path.exists():
            print(f'missing SPV: {spv_path}', file=sys.stderr)
            return 1
        data = spv_path.read_bytes()
        if len(data) % 4 != 0:
            print(f'warn: {spv_path} byte length {len(data)} is not a '
                  'multiple of 4 (SPIR-V should be 32-bit-aligned)', file=sys.stderr)
        parts.append(emit_array(var_name, data))

    out_path.write_text('\n'.join(parts))
    return 0


if __name__ == '__main__':
    sys.exit(main())
