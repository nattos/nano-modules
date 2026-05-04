#!/usr/bin/env python3
"""
Strip the synthetic wrapper main from a transpiled fragment file.

The fragment build path (compile_shaders_compute_fused in
wasm_build_env.sh) wraps an effect's pixel.hlsl with a no-op main()
that calls fuse_transform once, then runs it through DXC + naga to
produce WGSL and MSL. The wrapper exists only to give DXC something to
hang an entry point off — the engine never executes it. We strip:

  WGSL:
    - var<private> global: vec3<u32>;          (synthetic builtin shim)
    - var _fuse_out: texture_storage_2d<...>;  (synthetic output)
    - fn main_1() { ... }                       (wrapper body)
    - @compute @workgroup_size(...) fn main(...) { ... }  (entry point)

  MSL:
    - void main_1(...) { ... }
    - struct main_Input { ... };
    - kernel void main_(...) { ... }

What's left is exactly the per-pixel fragment: struct definitions,
the cbuffer's uniform var, helper functions, and fuse_transform.

The strip pass also asserts that the surviving text still contains
fuse_transform — so a refactor that breaks the assumption fails the
build instead of silently shipping an empty fragment.

Usage: _fragment_strip.py <wgsl|msl> <input> <output>
"""

import re
import sys
from pathlib import Path


def strip_block(text: str, header_pattern: re.Pattern) -> str:
    """Remove blocks matching `header_pattern` and their balanced { ... }
    body. Header pattern must end at the position of the opening brace
    OR before it on the same line."""
    out = []
    i = 0
    while i < len(text):
        m = header_pattern.search(text, i)
        if not m:
            out.append(text[i:])
            break
        out.append(text[i:m.start()])
        # Find the opening brace at or after the match end.
        j = text.find('{', m.end() - 1)
        if j < 0:
            # No brace — drop just the matched line.
            line_end = text.find('\n', m.end())
            i = (line_end + 1) if line_end >= 0 else len(text)
            continue
        depth = 0
        k = j
        while k < len(text):
            ch = text[k]
            if ch == '{':
                depth += 1
            elif ch == '}':
                depth -= 1
                if depth == 0:
                    k += 1
                    break
            k += 1
        # Skip trailing whitespace, an optional semicolon (e.g. after
        # `struct main_Input {};`), and the newline.
        while k < len(text) and text[k] in ' \t':
            k += 1
        if k < len(text) and text[k] == ';':
            k += 1
        while k < len(text) and text[k] in ' \t':
            k += 1
        if k < len(text) and text[k] == '\n':
            k += 1
        i = k
    return ''.join(out)


def strip_line(text: str, line_pattern: re.Pattern) -> str:
    """Remove lines matching `line_pattern`."""
    return ''.join(
        line for line in text.splitlines(keepends=True)
        if not line_pattern.search(line)
    )


def strip_wgsl(text: str) -> str:
    text = strip_line(text, re.compile(r'^\s*var<private>\s+global\s*:'))
    text = strip_line(text, re.compile(r'^\s*var\s+_fuse_out\s*:'))
    # @binding line preceding the _fuse_out var (its line was the previous one).
    # We catch it by removing any standalone @group(...) @binding(...) line that
    # has no following declaration. Simpler: remove the orphaned @group/@binding
    # by pattern when followed by a blank line.
    text = re.sub(
        r'@group\(\d+\)\s*@binding\(\d+\)\s*\n(?=\s*\n)',
        '',
        text,
    )
    text = strip_block(text, re.compile(r'\bfn\s+main_1\s*\(\s*\)'))
    text = strip_block(
        text,
        re.compile(r'@compute[^{]*?\bfn\s+main\s*\([^)]*\)'),
    )
    return text


def strip_msl(text: str) -> str:
    text = strip_block(text, re.compile(r'\bvoid\s+main_1\s*\('))
    text = strip_block(text, re.compile(r'\bstruct\s+main_Input\s*'))
    text = strip_block(text, re.compile(r'\bkernel\s+void\s+main_\s*\('))
    return text


def main() -> int:
    if len(sys.argv) != 4:
        print(__doc__, file=sys.stderr)
        return 2
    lang, src, dst = sys.argv[1], sys.argv[2], sys.argv[3]
    text = Path(src).read_text()
    if lang == 'wgsl':
        out = strip_wgsl(text)
    elif lang == 'msl':
        out = strip_msl(text)
    else:
        print(f'unknown lang {lang}', file=sys.stderr)
        return 2
    if 'fuse_transform' not in out:
        print(
            f'[fragment_strip] {src}: stripped output is missing fuse_transform; '
            'aborting build to avoid shipping an empty fragment',
            file=sys.stderr,
        )
        return 1
    Path(dst).write_text(out)
    return 0


if __name__ == '__main__':
    sys.exit(main())
