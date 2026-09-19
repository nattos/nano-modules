#!/bin/bash
# WAMR 2.2.0's Windows platform layer does not compile with clang or gcc.
#
# core/shared/platform/windows/win_file.c ends three `//` comments with a
# backslash followed by a space:
#
#     // Starts with \??\
#
# MSVC stops the comment at the newline. Clang and GCC treat backslash-
# whitespace-newline as a LINE SPLICE, swallow the following line into the
# comment, and the file stops parsing:
#
#     win_file.c:1300:20: error: expected identifier
#
# So the `__MINGW64_VERSION_MAJOR` guard further down that same file is
# aspirational — upstream has only ever built this with MSVC.
#
# Appending a '.' ends the comment with a non-backslash and changes nothing
# else. Idempotent: a patched line no longer matches.
set -euo pipefail
f="core/shared/platform/windows/win_file.c"
[ -f "$f" ] || { echo "patch-wamr-windows: $f not found (wrong cwd?)" >&2; exit 1; }
perl -pi -e 's{^(\s*//.*\\)[ \t]*$}{$1.}' "$f"
if grep -qE '^\s*//.*\\[ \t]*$' "$f"; then
  echo "patch-wamr-windows: trailing-backslash comments remain in $f" >&2
  exit 1
fi
echo "patch-wamr-windows: ok"
