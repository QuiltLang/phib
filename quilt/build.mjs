// Builds the Quilt writers bench.mjs compares with compile.js's writeSource
// (see anchors.ts.quilt): anchors-str.mjs as written (`ts⟨str⟩↖`, template
// literals), and the same file with its first tag changed to `ts↖`
// (anchors-cst.mjs, a syntax tree) and `ts⟨qt⟩↖` (anchors-qt.mjs, a flat
// term). Not part of the site.
//
//   node build.mjs <quilt CLI> <quilt-wasm package, from Quilt's `bin/build-wasm web <out>`>
//
// The ⟨str⟩ writer needs no runtime: its quotes are template literals and its
// `←` an inline join, so it is expanded with no import at all. The other two
// build terms, so they import Quilt's plain-JS runtime (quilt_runtime.js),
// copied into rt/ with the wasm they leave out, which bench.mjs weighs.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const [quilt, pkg] = process.argv.slice(2);
if (!quilt || !pkg) throw new Error("usage: node build.mjs <quilt CLI> <quilt-wasm pkg dir>");
const here = fileURLToPath(new URL(".", import.meta.url));
const src = readFileSync(join(here, "anchors.ts.quilt"), "utf8");
const FIRST = "ts⟨str⟩↖";
if (!src.includes(FIRST)) throw new Error(`anchors.ts.quilt must open its first quote with ${FIRST}`);
const runtime =
  'import { tb, leaf, sym, quote, unquote, cmd, write, push, name, qseq, qlift_str, qlift, NL, POP, HOLE } from "./rt/quilt_runtime.js";';
for (const [repr, tag, prelude] of [
  ["str", FIRST, "// A ⟨str⟩ writer: template literals, no runtime."],
  ["cst", "ts↖", runtime],
  ["qt", "ts⟨qt⟩↖", runtime],
]) {
  const file = `anchors-${repr}.ts.quilt`;
  writeFileSync(join(here, file), src.replace(FIRST, tag));
  execFileSync(quilt, ["expand", "--prelude", prelude, file], { cwd: here, stdio: "inherit" });
  renameSync(join(here, `anchors-${repr}.ts`), join(here, `anchors-${repr}.mjs`));
  rmSync(join(here, file));
}
mkdirSync(join(here, "rt"), { recursive: true });
for (const f of ["quilt_runtime.js", "quilt_wasm.js", "quilt_wasm_raw.js", "quilt_wasm_raw_bg.wasm"]) copyFileSync(join(pkg, f), join(here, "rt", f));
