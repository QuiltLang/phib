#!/usr/bin/env bash
#
# quilt/gen.sh [--check] — expand Phib's Quilt sources into the modules
# beside the engine (static/):
#   anchors.ts.quilt  -> anchors.js, compile.js's anchor tests (JavaScript)
#   wgsl.ts.quilt     -> wgsl.js, compile-gpu.js's shader (WGSL)
#   print.ts.quilt    -> print.js, syntax.js's printers (Phib itself)
#
# Their quotes are `⟨str⟩` (template literals), so the expansions need no
# runtime: each is written with a comment where the runtime import would go.
# With --check it writes nothing, and fails if any module is not its source
# expanded. Needs the `quilt` CLI:
#   cargo install --git https://github.com/QuiltLang/quilt --rev 89f0e13 quiltlang
#
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
static="$here/../src/phib/static"
check=0
[ "${1:-}" = "--check" ] && check=1

QUILT="${QUILT:-quilt}"
if ! command -v "$QUILT" >/dev/null; then
  echo "quilt: no quilt CLI (set QUILT, or: cargo install --git https://github.com/QuiltLang/quilt --rev 89f0e13 quiltlang)" >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
stale=0
for name in anchors wgsl print; do
  cp "$here/$name.ts.quilt" "$work/"
  (cd "$work" && "$QUILT" expand --prelude "// No runtime: its quotes are ⟨str⟩, template literals." "$name.ts.quilt")
  if [ $check = 1 ]; then
    if ! diff -q "$work/$name.ts" "$static/$name.js" >/dev/null; then
      echo "quilt: static/$name.js is stale: run quilt/gen.sh" >&2
      stale=1
    fi
  else
    cp "$work/$name.ts" "$static/$name.js"
    echo "quilt: wrote static/$name.js"
  fi
done
[ $stale = 1 ] && exit 1
[ $check = 1 ] && echo "quilt: ok, static/{anchors,wgsl,print}.js are their sources expanded"
exit 0
